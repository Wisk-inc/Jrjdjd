/* ==========================================================================
   Corx — the client.

   Auth: @openai-oauth/web (vendored, built unmodified from the published
   package). Messages stream from /api/chat over the visitor's own ChatGPT
   session. Tools run in a real Python VM in this tab (assets/js/sandbox.js),
   with internet access and search through /api/fetch and /api/search.

   Nothing here is simulated. Every line in the terminal is a command that ran.
   ========================================================================== */
import {
  completeLogin, getSession, logout, openaiAuthHeaders, startLogin
} from '/assets/vendor/openai-oauth-web.js';
import * as sandbox from '/assets/js/sandbox.js';

const $ = (s, r) => (r || document).querySelector(s);
const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const STORE = 'corx.chat.v2';
const FALLBACK_MODELS = [
  'gpt-5.2', 'gpt-5.2-codex', 'gpt-5.1', 'gpt-5.1-codex', 'gpt-5.1-codex-mini',
  'gpt-5', 'gpt-5-codex'
];
const MAX_ROUNDS = 16;
const MAX_CONVS = 20;

/* ------------------------------------------------------------------ store */
const defaults = () => ({
  model: null, theme: 'auto', memory: true, think: true,
  conversations: [], activeId: null, run: null
});
let db = defaults();

function loadDb() {
  try { db = { ...defaults(), ...(JSON.parse(localStorage.getItem(STORE)) || {}) }; }
  catch { db = defaults(); }
}
function saveDb() {
  try {
    const trimmed = {
      ...db,
      conversations: db.conversations.slice(0, MAX_CONVS).map((c) => ({
        ...c, messages: c.messages.slice(-60)
      }))
    };
    localStorage.setItem(STORE, JSON.stringify(trimmed));
  } catch { /* quota or private mode */ }
}

const activeConv = () => db.conversations.find((c) => c.id === db.activeId) || null;

function newConversation() {
  const conv = { id: `c${Date.now()}`, title: 'New chat', updated: Date.now(), messages: [] };
  db.conversations.unshift(conv);
  db.activeId = conv.id;
  saveDb();
  return conv;
}

/* ------------------------------------------------------------------ state */
const state = {
  models: [], catalog: new Map(), profile: null, running: false, abort: null,
  attachments: [], plan: [], files: new Map(), openFile: null
};

/* ------------------------------------------------------------------ tools */
const TOOLS = [
  { type: 'function', function: { name: 'set_plan',
    description: 'Publish the plan for a multi-step job before starting it. Shown to the user as a live checklist. Call this first for anything with more than two steps.',
    parameters: { type: 'object', properties: { steps: { type: 'array', items: { type: 'string' } } }, required: ['steps'] } } },
  { type: 'function', function: { name: 'complete_step',
    description: 'Mark a plan step finished and move to the next.',
    parameters: { type: 'object', properties: { index: { type: 'integer', description: 'Zero-based step index.' } }, required: ['index'] } } },
  { type: 'function', function: { name: 'run_python',
    description: 'Execute Python in the sandbox. State persists between calls. `import web` then `await web.get(url)` for internet access. Python\'s zipfile, csv, json and sqlite3 are all available.',
    parameters: { type: 'object', properties: { code: { type: 'string' } }, required: ['code'] } } },
  { type: 'function', function: { name: 'install_packages',
    description: 'Install Python packages with micropip.',
    parameters: { type: 'object', properties: { packages: { type: 'array', items: { type: 'string' } } }, required: ['packages'] } } },
  { type: 'function', function: { name: 'write_file',
    description: 'Create or overwrite a text file in /work. Use for code, documents, data — anything the user should be able to read, edit or download.',
    parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } } },
  { type: 'function', function: { name: 'read_file',
    description: 'Read a text file from the sandbox.',
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } } },
  { type: 'function', function: { name: 'delete_file',
    description: 'Delete a file from the sandbox.',
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } } },
  { type: 'function', function: { name: 'list_files',
    description: 'List files in the sandbox.',
    parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'web_search',
    description: 'Search the web for real results with titles, URLs and snippets. Use whenever the answer depends on current information.',
    parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } } },
  { type: 'function', function: { name: 'fetch_url',
    description: 'Fetch a URL and return its text, to read a page or call an API.',
    parameters: { type: 'object', properties: { url: { type: 'string' }, method: { type: 'string', enum: ['GET', 'POST'] }, body: { type: 'string' } }, required: ['url'] } } },
  { type: 'function', function: { name: 'generate_image',
    description: 'Generate an image from a prompt. Shown to the user and saved to the canvas.',
    parameters: { type: 'object', properties: { prompt: { type: 'string' }, size: { type: 'string', enum: ['1024x1024', '1536x1024', '1024x1536'] } }, required: ['prompt'] } } },
  { type: 'function', function: { name: 'deliver_file',
    description: 'Hand a sandbox file to the user as a download. Use after building a file, document or zip.',
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } } }
];

const TOOL_LABEL = {
  set_plan: 'Planning', complete_step: 'Step done', run_python: 'Running Python',
  install_packages: 'Installing', write_file: 'Writing', read_file: 'Reading',
  delete_file: 'Deleting', list_files: 'Listing files', web_search: 'Searching the web',
  fetch_url: 'Fetching', generate_image: 'Generating image', deliver_file: 'Delivering'
};

async function execTool(name, args) {
  switch (name) {
    case 'set_plan':
      state.plan = (args.steps || []).map((t) => ({ text: String(t), state: 'todo' }));
      if (state.plan[0]) state.plan[0].state = 'active';
      paintPlan(); openDock('plan');
      return `Plan published with ${state.plan.length} steps.`;

    case 'complete_step': {
      const i = Number(args.index);
      if (state.plan[i]) state.plan[i].state = 'done';
      const next = state.plan.find((s) => s.state === 'todo');
      if (next) next.state = 'active';
      paintPlan();
      return `Step ${i + 1} marked done.`;
    }

    case 'run_python':
      openDock('terminal');
      return (await sandbox.runPython(args.code || '')).output || '(no output)';

    case 'install_packages':
      openDock('terminal');
      return (await sandbox.installPackages(args.packages || [])).output;

    case 'write_file': {
      const r = await sandbox.writeFile(args.path, args.content ?? '');
      await syncFiles();
      return r.output;
    }

    case 'read_file':
      try { return await sandbox.readFile(args.path); }
      catch (e) { return e.message; }

    case 'delete_file':
      try { const r = await sandbox.deleteFile(args.path); await syncFiles(); return r.output; }
      catch (e) { return e.message; }

    case 'list_files': {
      const files = await sandbox.listFiles();
      await syncFiles();
      return files.length ? files.map((f) => `${f.path} (${f.size}B)`).join('\n') : '(empty)';
    }

    case 'web_search': {
      const q = String(args.query || '').trim();
      const strip = showSearchStrip(q);
      termLine('cmd', `search "${q}"`);
      const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`);
      const data = await res.json().catch(() => ({}));
      const results = data.results || [];
      strip.remove();
      if (!results.length) {
        termLine('err', data.error || 'no results');
        return `No results${data.error ? ` (${data.error})` : ''}.`;
      }
      termLine('ok', `${results.length} results`);
      renderSources(results);
      return results.map((r, i) => `[${i + 1}] ${r.title}\n${r.url}\n${r.snippet}`).join('\n\n');
    }

    case 'fetch_url': {
      termLine('cmd', `fetch ${args.url}`);
      const res = await fetch('/api/fetch', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url: args.url, method: args.method || 'GET', body: args.body })
      });
      const data = await res.json().catch(() => ({}));
      if (data.error) { termLine('err', data.error); return `Error: ${data.error}`; }
      termLine('ok', `${data.status} — ${String(data.body).length} chars`);
      return `HTTP ${data.status}\n\n${String(data.body).slice(0, 12000)}`;
    }

    case 'generate_image': {
      termLine('cmd', `image "${String(args.prompt || '').slice(0, 60)}"`);
      const res = await fetch('/api/image', {
        method: 'POST',
        headers: { ...(await authHeaders()), 'content-type': 'application/json' },
        body: JSON.stringify({ prompt: args.prompt, size: args.size })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.image) {
        const msg = data.message || data.error || `failed (${res.status})`;
        termLine('err', msg);
        return `Image generation failed: ${msg}`;
      }
      termLine('ok', 'image generated');
      renderImage(data.image, args.prompt);
      const name = `image-${Date.now()}.png`;
      state.files.set(name, { kind: 'image', dataUrl: data.image, size: '—' });
      paintFiles();
      return `Image generated and shown to the user, saved to the canvas as ${name}.`;
    }

    case 'deliver_file': {
      try {
        const bytes = await sandbox.readFile(String(args.path), true);
        const name = String(args.path).split('/').pop();
        download(name, bytes);
        termLine('ok', `delivered ${name}`);
        return `Delivered ${name} as a download.`;
      } catch (e) { termLine('err', e.message); return e.message; }
    }

    default: return `Unknown tool: ${name}`;
  }
}

/* --------------------------------------------------------------- markdown */
function renderMarkdown(src) {
  const blocks = [];
  let text = String(src).replace(/```([\w.+-]*)\n?([\s\S]*?)```/g, (_, lang, code) => {
    blocks.push({ lang: lang || 'text', code: code.replace(/\n$/, '') });
    return `\nCORXCODE${blocks.length - 1}\n`;
  });
  text = esc(text)
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');

  const out = []; let list = null;
  const closeList = () => { if (list) { out.push(`</${list}>`); list = null; } };
  for (const raw of text.split('\n')) {
    const line = raw.trimEnd();
    const ph = line.trim().match(/^CORXCODE(\d+)$/);
    if (ph) { closeList(); const b = blocks[+ph[1]];
      out.push(`<pre data-lang="${esc(b.lang)}"><code>${esc(b.code)}</code></pre>`); continue; }
    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) { closeList(); out.push(`<h4>${h[2]}</h4>`); continue; }
    const ul = line.match(/^\s*[-*]\s+(.*)$/);
    const ol = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (ul || ol) { const want = ul ? 'ul' : 'ol';
      if (list !== want) { closeList(); out.push(`<${want}>`); list = want; }
      out.push(`<li>${(ul || ol)[1]}</li>`); continue; }
    closeList();
    if (line.trim()) out.push(`<p>${line}</p>`);
  }
  closeList();
  return { html: out.join('\n'), blocks };
}

function splitReasoning(text) {
  const m = String(text).match(/<thinking>([\s\S]*?)(<\/thinking>|$)/i);
  if (!m) return { reasoning: '', answer: text };
  return {
    reasoning: m[1].trim(),
    answer: String(text).replace(/<thinking>[\s\S]*?(<\/thinking>|$)/i, '').trim()
  };
}

/* ------------------------------------------------------------------- view */
const els = {};
let currentNode = null;

const setPhase = (p) => document.body.setAttribute('data-chat-phase', p);
function setStatus(msg, kind) {
  if (!els.status) return;
  els.status.textContent = msg || '';
  els.status.setAttribute('data-kind', kind || 'info');
}
const scrollDown = () => { if (els.thread) els.thread.scrollTop = els.thread.scrollHeight; };

function addMessage(role, html) {
  const wrap = document.createElement('div');
  wrap.className = `msg msg-${role}`;
  const who = role === 'user'
    ? `<span class="chat-avatar" aria-hidden="true">${esc(initial())}</span> ${esc(displayName())}`
    : 'Corx';
  wrap.innerHTML = `<p class="msg-role">${who}</p>` +
    `<div class="msg-reasoning"></div><div class="msg-tools"></div><div class="msg-body"></div>`;
  $('.msg-body', wrap).innerHTML = html;
  els.threadInner.appendChild(wrap);
  if (els.empty) els.empty.hidden = true;
  scrollDown();
  return wrap;
}

function paintReasoning(node, reasoning) {
  const slot = $('.msg-reasoning', node);
  if (!slot) return;
  if (!reasoning) { slot.innerHTML = ''; return; }
  if (!$('details', slot)) {
    slot.innerHTML = `<details class="think"><summary>` +
      `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3a6 6 0 0 0-3.5 10.9V17h7v-3.1A6 6 0 0 0 12 3z"/><path d="M9.5 20h5"/></svg>` +
      `<span class="think-label">Thinking…</span>` +
      `<span class="chev" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg></span>` +
      `</summary><div class="think-body"></div></details>`;
  }
  $('.think-body', slot).innerHTML = renderMarkdown(reasoning).html;
}
function finishReasoning(node, seconds) {
  const l = $('.think-label', node);
  if (l) l.textContent = `Thought for ${seconds} second${seconds === 1 ? '' : 's'}`;
}

/* tool cards, inline in the conversation */
function addToolCard(name, args) {
  if (!currentNode) return null;
  const slot = $('.msg-tools', currentNode);
  const card = document.createElement('div');
  card.className = 'tool-card';
  card.setAttribute('data-state', 'running');
  const arg = args.path || args.query || args.url || args.prompt
    || (args.packages || []).join(' ') || (args.code ? args.code.split('\n')[0] : '');
  card.innerHTML =
    `<div class="tool-head">` +
    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m8 9-3 3 3 3M16 9l3 3-3 3"/></svg>` +
    `<span class="tool-name">${esc(TOOL_LABEL[name] || name)}</span>` +
    `<span class="tool-arg">${esc(String(arg).slice(0, 120))}</span>` +
    `<span class="tool-state">Running</span></div>`;
  slot.appendChild(card);
  scrollDown();
  return card;
}
function finishToolCard(card, output, failed) {
  if (!card) return;
  card.setAttribute('data-state', failed ? 'error' : 'done');
  $('.tool-state', card).textContent = failed ? 'Failed' : 'Done';
  const text = String(output || '').trim();
  if (text) {
    const pre = document.createElement('pre');
    pre.className = 'tool-out';
    pre.textContent = text.slice(0, 4000);
    card.appendChild(pre);
  }
  scrollDown();
}

/* the sliding-logo strip while a search is in flight */
function showSearchStrip(query) {
  const slot = currentNode ? $('.msg-tools', currentNode) : null;
  const strip = document.createElement('div');
  strip.className = 'search-strip';
  strip.innerHTML = `<span class="label">Searching “${esc(query.slice(0, 40))}”</span>` +
    `<span class="track">${['wikipedia.org', 'github.com', 'nature.com', 'reuters.com', 'arxiv.org']
      .map((d) => `<img class="favicon" alt="" src="https://icons.duckduckgo.com/ip3/${d}.ico">`).join('')}</span>`;
  (slot || document.body).appendChild(strip);
  scrollDown();
  return strip;
}

function renderSources(results) {
  const slot = currentNode ? $('.msg-tools', currentNode) : null;
  if (!slot) return;
  const box = document.createElement('div');
  box.className = 'sources';
  box.innerHTML = `<div class="sources-head">` +
    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m16.5 16.5 4 4"/></svg>` +
    `Searched the web · ${results.length} source${results.length === 1 ? '' : 's'}</div><div class="source-row"></div>`;
  const row = $('.source-row', box);
  for (const r of results) {
    const a = document.createElement('a');
    a.className = 'source'; a.href = r.url; a.target = '_blank'; a.rel = 'noopener nofollow';
    a.innerHTML = `<img class="favicon" alt="" width="16" height="16" loading="lazy" ` +
      `src="https://icons.duckduckgo.com/ip3/${encodeURIComponent(r.domain)}.ico">` +
      `<span>${esc(r.domain || r.title)}</span>`;
    row.appendChild(a);
  }
  slot.appendChild(box);
  scrollDown();
}

function renderImage(src, prompt) {
  const slot = currentNode ? $('.msg-tools', currentNode) : null;
  if (!slot) return;
  const fig = document.createElement('figure');
  fig.className = 'gen-image';
  fig.innerHTML = `<img alt="${esc(prompt || 'Generated image')}" src="${esc(src)}">` +
    (prompt ? `<figcaption>${esc(prompt)}</figcaption>` : '');
  slot.appendChild(fig);
  scrollDown();
}

/* --------------------------------------------------------------- terminal */
function termLine(kind, text) {
  if (!els.term) return;
  for (const line of String(text).split('\n')) {
    const d = document.createElement('div');
    d.className = kind; d.textContent = line;
    els.term.appendChild(d);
  }
  els.term.parentElement.scrollTop = els.term.parentElement.scrollHeight;
  if (els.termEmpty) els.termEmpty.hidden = true;
  markDockActivity('terminal');
}

/* ------------------------------------------------------------------- plan */
function paintPlan() {
  if (!els.planList) return;
  els.planList.innerHTML = '';
  els.planEmpty.hidden = state.plan.length > 0;
  state.plan.forEach((s) => {
    const li = document.createElement('li');
    li.setAttribute('data-state', s.state);
    li.textContent = s.text;
    els.planList.appendChild(li);
  });
  markDockActivity('plan');
}

/* ----------------------------------------------------------------- canvas */
async function syncFiles() {
  if (!sandbox.isReady()) return;
  let files = [];
  try { files = await sandbox.listFiles(); } catch { return; }
  const seen = new Set();
  for (const f of files) {
    const name = f.path.replace(`${sandbox.workdir()}/`, '');
    seen.add(name);
    state.files.set(name, { kind: 'sandbox', path: f.path, size: `${(f.size / 1024).toFixed(1)} KB` });
  }
  for (const [name, meta] of state.files) {
    if (meta.kind === 'sandbox' && !seen.has(name)) state.files.delete(name);
  }
  paintFiles();
}

function paintFiles() {
  if (!els.canvasList) return;
  const empty = els.canvasEmpty;
  els.canvasList.innerHTML = '';
  els.canvasList.appendChild(empty);
  empty.hidden = state.files.size > 0;
  for (const [name, meta] of state.files) {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'canvas-file';
    b.setAttribute('aria-current', String(state.openFile === name));
    b.innerHTML = `<span class="lang">${esc((name.split('.').pop() || 'txt').slice(0, 5))}</span>` +
      `<span class="fname">${esc(name)}</span><span class="size">${esc(meta.size)}</span>`;
    b.addEventListener('click', () => openFile(name));
    els.canvasList.appendChild(b);
  }
  if (els.dockCount) els.dockCount.textContent = String(state.files.size);
  markDockActivity('canvas');
}

async function openFile(name) {
  const meta = state.files.get(name);
  if (!meta) return;
  state.openFile = name;
  paintFiles();
  els.editorName.textContent = name;
  els.editor.hidden = false;
  if (meta.kind === 'image') {
    els.editorArea.value = '(binary image — use Download)';
    els.editorArea.readOnly = true;
  } else {
    els.editorArea.readOnly = false;
    try { els.editorArea.value = await sandbox.readFile(meta.path); }
    catch (e) { els.editorArea.value = `(could not read: ${e.message})`; }
  }
}

function download(name, content) {
  const blob = content instanceof Uint8Array ? new Blob([content])
    : new Blob([String(content)], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

/* -------------------------------------------------------------- dock util */
const narrow = () => window.matchMedia('(max-width: 1100px)').matches;

function openDock(panel) {
  if (panel) selectPanel(panel);
  /* On a phone the panel is a full-height overlay, so opening it on the
     agent's behalf would bury the answer the user is reading. Flag it
     instead and let them tap in. */
  if (narrow()) { els.dockToggle?.setAttribute('data-active', 'true'); return; }
  const app = $('#chat-app');
  app.setAttribute('data-dock', 'open');
  app.setAttribute('data-sidebar', 'closed');
  els.dockToggle?.setAttribute('aria-pressed', 'true');
  syncScrim();
}
function selectPanel(panel) {
  $$('.dock-tab').forEach((t) => {
    const on = t.getAttribute('data-panel') === panel;
    t.setAttribute('aria-selected', String(on));
    if (on) t.removeAttribute('data-active');
  });
  $$('.dock-panel').forEach((p) => { p.hidden = p.getAttribute('data-panel') !== panel; });
}
function markDockActivity(panel) {
  const tab = $(`.dock-tab[data-panel="${panel}"]`);
  if (tab && tab.getAttribute('aria-selected') !== 'true') tab.setAttribute('data-active', 'true');
}
function syncScrim() {
  const app = $('#chat-app');
  if (!els.scrim || !app) return;
  const overlaid = app.getAttribute('data-sidebar') === 'open' || app.getAttribute('data-dock') === 'open';
  els.scrim.hidden = !(overlaid && narrow());
}

/* ------------------------------------------------------------------- auth */
function claimsOf(token) {
  try {
    const part = String(token).split('.')[1];
    const json = atob(part.replace(/-/g, '+').replace(/_/g, '/'));
    return JSON.parse(decodeURIComponent(escape(json)));
  } catch { return {}; }
}
function readProfile(session) {
  if (!session?.accessToken) return null;
  const c = claimsOf(session.accessToken);
  const p = c['https://api.openai.com/profile'] || c.profile || {};
  const email = p.email || c.email || '';
  const name = p.name || c.name || (email ? email.split('@')[0] : '');
  return { name: name || 'Your account', email };
}
const displayName = () => state.profile?.name || 'You';
const initial = () => (displayName()[0] || 'Y').toUpperCase();

/* Never sign the user out over a transient failure — only when the session
   itself is genuinely gone. */
async function authHeaders() { return openaiAuthHeaders(); }
async function sessionAlive() {
  try { return Boolean(await getSession()); } catch { return false; }
}

async function refreshModels() {
  try {
    const res = await fetch('/api/models', { headers: await authHeaders() });
    if (res.ok) {
      const { models, catalog } = await res.json();
      if (Array.isArray(models) && models.length) state.models = models;
      if (Array.isArray(catalog)) {
        state.catalog = new Map(catalog.map((m) => [m.id, m]));
      }
    }
  } catch { /* fall through */ }
  if (!state.models.length) state.models = FALLBACK_MODELS;
  if (!state.models.includes(db.model)) db.model = state.models[0];
  saveDb();
  paintModels();
}

/* A slug is not a description. These are the families the Codex catalog
   returns; anything unrecognised falls back to its reasoning level. */
function modelNote(id) {
  const meta = state.catalog?.get(id);
  const bits = [];
  if (/codex/.test(id)) bits.push('built for code');
  else bits.push('general purpose');
  if (/mini/.test(id)) bits.push('fastest');
  else if (meta?.reasoning) bits.push(`${meta.reasoning} reasoning`);
  if (meta && meta.listed === false) bits.push('preview');
  return bits.join(' · ');
}

function paintModels() {
  if (!els.modelMenu) return;
  els.modelMenu.innerHTML = '';
  for (const id of state.models) {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'model-opt'; b.setAttribute('role', 'option');
    b.setAttribute('aria-selected', String(id === db.model));
    b.innerHTML = `<span class="model-opt-text"><strong>${esc(id)}</strong>` +
      `<small>${esc(modelNote(id))}</small></span>` +
      `<span class="check"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m4 12.5 5 5L20 6.5"/></svg></span>`;
    b.addEventListener('click', () => {
      db.model = id; saveDb(); paintModels();
      els.modelMenu.hidden = true;
      els.modelBtn.setAttribute('aria-expanded', 'false');
    });
    els.modelMenu.appendChild(b);
  }
  if (els.modelName) els.modelName.textContent = db.model || 'Model';
}

/* ---------------------------------------------------------- conversations */
function paintConversations() {
  if (!els.convList) return;
  els.convList.innerHTML = '';
  if (!db.conversations.length) {
    els.convList.innerHTML = '<p class="panel-empty" style="padding:10px 8px">No saved chats yet.</p>';
    return;
  }
  const h = document.createElement('p');
  h.className = 'hist-group'; h.textContent = 'Chats';
  els.convList.appendChild(h);
  for (const c of db.conversations) {
    const row = document.createElement('div');
    row.className = 'conv';
    row.setAttribute('aria-current', String(c.id === db.activeId));
    row.innerHTML = `<span class="conv-title">${esc(c.title)}</span>` +
      `<button class="conv-del" type="button" aria-label="Delete chat"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M5 7h14M10 7V5h4v2M8 7l1 12h6l1-12"/></svg></button>`;
    $('.conv-title', row).addEventListener('click', () => switchConversation(c.id));
    $('.conv-del', row).addEventListener('click', (e) => {
      e.stopPropagation();
      db.conversations = db.conversations.filter((x) => x.id !== c.id);
      if (db.activeId === c.id) { db.activeId = db.conversations[0]?.id || null; renderConversation(); }
      saveDb(); paintConversations();
    });
    els.convList.appendChild(row);
  }
}

function switchConversation(id) {
  db.activeId = id; saveDb();
  renderConversation(); paintConversations();
  $('#chat-app').setAttribute('data-sidebar', 'closed'); syncScrim();
}

function renderConversation() {
  els.threadInner.innerHTML = '';
  els.threadInner.appendChild(els.empty);
  const conv = activeConv();
  els.empty.hidden = Boolean(conv && conv.messages.length);
  if (!conv) return;
  for (const m of conv.messages) {
    if (m.role === 'tool' || (m.role === 'assistant' && !m.content)) continue;
    const text = typeof m.content === 'string' ? m.content
      : (Array.isArray(m.content) ? m.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n') : '');
    if (!text) continue;
    const { reasoning, answer } = m.role === 'assistant' ? splitReasoning(text) : { reasoning: '', answer: text };
    const node = addMessage(m.role === 'user' ? 'user' : 'assistant', renderMarkdown(answer).html);
    if (reasoning) { paintReasoning(node, reasoning); finishReasoning(node, 0); }
  }
}

/* ------------------------------------------------------------------ agent */
async function streamOnce(node, startedAt) {
  const conv = activeConv();
  const history = db.memory ? conv.messages : conv.messages.slice(-2);

  state.abort = new AbortController();
  const res = await fetch('/api/chat', {
    method: 'POST',
    signal: state.abort.signal,
    headers: { ...(await authHeaders()), 'content-type': 'application/json' },
    body: JSON.stringify({
      model: db.model, messages: history, tools: TOOLS,
      locale: navigator.language || '',
      region: Intl.DateTimeFormat().resolvedOptions().timeZone || ''
    })
  });

  if (!res.ok) {
    const d = await res.json().catch(() => ({}));
    if (res.status === 401 && d.error === 'missing_credentials') {
      // Credentials did not reach the server. Only a dead session justifies
      // signing out; otherwise this is a transport or deploy problem.
      if (!(await sessionAlive())) { setPhase('signed-out'); throw new Error('Signed out. Connect again.'); }
      throw new Error('The server did not receive your credentials. Run the connection test from your profile menu.');
    }
    if (res.status === 403 && d.error === 'upstream_rejected') {
      const note = String(d.message || '').slice(0, 240);
      throw new Error(
        `ChatGPT refused the request (${d.status})${d.model ? ` for ${d.model}` : ''}. ` +
        `Try another model from the picker — your plan may not include this one.` +
        (note ? ` Upstream said: ${note}` : '')
      );
    }
    throw new Error(d.message || `Request failed (${res.status}).`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const body = $('.msg-body', node);
  let buffer = '', content = '';
  const calls = [];

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const frames = buffer.split('\n\n');
    buffer = frames.pop() || '';
    for (const frame of frames) {
      for (const line of frame.split('\n')) {
        if (!line.startsWith('data:')) continue;
        const raw = line.slice(5).trim();
        if (!raw || raw === '[DONE]') continue;
        let evt; try { evt = JSON.parse(raw); } catch { continue; }
        const delta = evt?.choices?.[0]?.delta;
        if (!delta) continue;
        if (delta.content) {
          content += delta.content;
          const { reasoning, answer } = splitReasoning(content);
          if (reasoning) paintReasoning(node, reasoning);
          body.innerHTML = answer ? renderMarkdown(answer).html
            : '<p class="typing"><span></span><span></span><span></span></p>';
          scrollDown();
        }
        for (const tc of delta.tool_calls || []) {
          const i = tc.index ?? calls.length;
          calls[i] = calls[i] || { id: '', name: '', args: '' };
          if (tc.id) calls[i].id = tc.id;
          if (tc.function?.name) calls[i].name += tc.function.name;
          if (tc.function?.arguments) calls[i].args += tc.function.arguments;
        }
      }
    }
  }

  const { reasoning, answer } = splitReasoning(content);
  if (reasoning) { paintReasoning(node, reasoning); finishReasoning(node, Math.max(1, Math.round((Date.now() - startedAt) / 1000))); }
  if (answer) { body.innerHTML = renderMarkdown(answer).html; }
  else if (!calls.length) { body.innerHTML = '<p>The model returned an empty response.</p>'; }
  return { content, calls: calls.filter(Boolean) };
}

async function runTurn() {
  const conv = activeConv();
  const startedAt = Date.now();
  const node = addMessage('assistant', '<p class="typing"><span></span><span></span><span></span></p>');
  currentNode = node;
  const body = $('.msg-body', node);

  db.run = { conversationId: conv.id, active: true };
  saveDb();

  try {
    for (let round = 0; round < MAX_ROUNDS; round += 1) {
      const { content, calls } = await streamOnce(node, startedAt);
      if (!calls.length) { conv.messages.push({ role: 'assistant', content }); break; }

      conv.messages.push({
        role: 'assistant', content: content || null,
        tool_calls: calls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.args || '{}' } }))
      });

      for (const call of calls) {
        let args = {}; try { args = JSON.parse(call.args || '{}'); } catch { /* malformed */ }
        const card = addToolCard(call.name, args);
        let output, failed = false;
        try { output = await execTool(call.name, args); }
        catch (err) { output = `Tool error: ${err.message}`; failed = true; }
        finishToolCard(card, output, failed);
        conv.messages.push({ role: 'tool', tool_call_id: call.id, content: String(output).slice(0, 20000) });
      }
      body.innerHTML = '<p class="typing"><span></span><span></span><span></span></p>';
    }
  } catch (err) {
    if (err.name !== 'AbortError') body.innerHTML = `<p class="msg-error">${esc(err.message)}</p>`;
    else body.innerHTML += '<p class="msg-error">Stopped.</p>';
  } finally {
    db.run = null;
    conv.updated = Date.now();
    if (db.memory) saveDb();
    paintConversations();
    await syncFiles();
  }
}

async function send(text) {
  if (state.running) return;
  state.running = true;
  els.send.disabled = true;
  els.stop.hidden = false;

  let conv = activeConv() || newConversation();
  if (conv.title === 'New chat' && text) {
    conv.title = text.slice(0, 46) + (text.length > 46 ? '…' : '');
    paintConversations();
  }

  const images = state.attachments.filter((a) => a.kind === 'image');
  const files = state.attachments.filter((a) => a.kind === 'file');
  let notes = '';
  for (const f of files) {
    try { await sandbox.writeFile(f.name, f.bytes); notes += `\n[Uploaded to the sandbox: /work/${f.name}]`; }
    catch (e) { notes += `\n[Could not stage ${f.name}: ${e.message}]`; }
  }
  if (files.length) await syncFiles();

  const outbound = images.length
    ? [{ type: 'text', text: text + notes }, ...images.map((a) => ({ type: 'image_url', image_url: { url: a.dataUrl } }))]
    : text + notes;
  conv.messages.push({ role: 'user', content: outbound });

  const chips = state.attachments.length
    ? `<div class="attach-row">${state.attachments.map((a) => `<span class="attach">${esc(a.name)}</span>`).join('')}</div>` : '';
  addMessage('user', chips + renderMarkdown(text).html);
  state.attachments = []; paintAttachments();

  await runTurn();

  state.running = false;
  els.send.disabled = false;
  els.stop.hidden = true;
  scrollDown();
}

function paintAttachments() {
  if (!els.attachRow) return;
  els.attachRow.innerHTML = '';
  els.attachRow.hidden = !state.attachments.length;
  state.attachments.forEach((a, i) => {
    const chip = document.createElement('span');
    chip.className = 'attach';
    chip.innerHTML = `${esc(a.name)} <button type="button" aria-label="Remove">&times;</button>`;
    $('button', chip).addEventListener('click', () => { state.attachments.splice(i, 1); paintAttachments(); });
    els.attachRow.appendChild(chip);
  });
}

/* ------------------------------------------------------------- diagnostics */
async function diagnostics() {
  const lines = [];
  const alive = await sessionAlive();
  lines.push(`Session in browser: ${alive ? 'present' : 'MISSING'}`);
  let h = {};
  try { h = await authHeaders(); lines.push(`Auth headers built: yes (${Object.keys(h).join(', ')})`); }
  catch (e) { lines.push(`Auth headers built: NO — ${e.message}`); }
  try {
    const r = await fetch('/api/models', { headers: h });
    const j = await r.json().catch(() => ({}));
    lines.push(`/api/models → ${r.status}${j.error ? ` (${j.error})` : ''}`);
    if (j.error === 'missing_credentials') {
      lines.push(`  server saw Authorization: ${j.sawAuthorization}, account-id: ${j.sawAccountId}`);
      lines.push('  → headers are being dropped in transit, or /api is not deployed.');
    }
    if (Array.isArray(j.models)) lines.push(`  models available: ${j.models.length}`);
  } catch (e) { lines.push(`/api/models → unreachable (${e.message})`); }
  openDock('terminal');
  termLine('sys', 'Connection test');
  lines.forEach((l) => termLine(l.includes('MISSING') || l.includes('NO ') ? 'err' : 'out', l));
}

/* ------------------------------------------------------------------ theme */
function applyTheme() {
  document.documentElement.setAttribute('data-theme', db.theme);
  $$('[data-theme-set]').forEach((b) => b.setAttribute('aria-pressed', String(b.getAttribute('data-theme-set') === db.theme)));
}

/* ------------------------------------------------------------------- boot */
async function boot() {
  setPhase('checking');
  try { await completeLogin(); }
  catch (e) { setStatus(`Sign-in did not complete: ${e.message}`, 'error'); }

  let session = null;
  try { session = await getSession(); } catch { session = null; }
  if (!session) { setPhase('signed-out'); return; }

  state.profile = readProfile(session);
  els.profileName.textContent = state.profile.name;
  els.profileInitial.textContent = initial();
  els.menuInitial.textContent = initial();
  els.menuName.textContent = state.profile.name;
  els.menuSub.textContent = state.profile.email || 'Signed in with ChatGPT';

  setPhase('ready');
  if (!db.conversations.length) newConversation();
  if (!db.activeId) db.activeId = db.conversations[0].id;
  renderConversation();
  paintConversations();
  await refreshModels();

  if (db.run?.active && db.run.conversationId === db.activeId) els.resumeBar.hidden = false;
  els.input?.focus();
}

async function connect() {
  setStatus('Opening the ChatGPT sign-in…', 'info');
  els.connect.disabled = true;
  try {
    const r = await startLogin();
    if (r.status === 'needs-extension') {
      els.install.href = r.installUrl;
      setStatus('The “Sign in with ChatGPT” extension is required. Install it, then press Connect again.', 'warn');
    }
  } catch (e) { setStatus(`Could not start sign-in: ${e.message}`, 'error'); }
  finally { els.connect.disabled = false; }
}

/* -------------------------------------------------------------------- init */
document.addEventListener('DOMContentLoaded', () => {
  const app = $('#chat-app');
  if (!app) return;
  loadDb();

  Object.assign(els, {
    thread: $('.chat-thread'), threadInner: $('.chat-thread-inner'), empty: $('#chat-empty'),
    input: $('#composer-input'), form: $('#composer-form'), send: $('#composer-send'),
    stop: $('#composer-stop'), status: $('#chat-status'), connect: $('#chat-connect'),
    install: $('#chat-install'), modelBtn: $('.model-btn'), modelName: $('.model-name'),
    modelMenu: $('.model-menu'), convList: $('#conversation-list'),
    profileBtn: $('#profile-btn'), profileMenu: $('#profile-menu'), profileName: $('#profile-name'),
    profileInitial: $('#profile-initial'), menuInitial: $('#menu-initial'),
    menuName: $('#menu-name'), menuSub: $('#menu-sub'),
    term: $('#terminal-out'), termEmpty: $('#terminal-empty'),
    planList: $('#plan-list'), planEmpty: $('#plan-empty'),
    canvasList: $('#canvas-list'), canvasEmpty: $('#canvas-empty'),
    editor: $('#canvas-editor'), editorName: $('#editor-name'), editorArea: $('#editor-area'),
    dockCount: $('#dock-count'), dockToggle: $('#dock-toggle'), scrim: $('#chat-scrim'),
    attachRow: $('#composer-attachments'), fileInput: $('#composer-file'),
    resumeBar: $('#resume-bar')
  });

  applyTheme();
  document.body.setAttribute('data-think', db.think ? 'on' : 'off');
  $('#think-toggle')?.setAttribute('aria-pressed', String(db.think));
  $('#memory-toggle')?.setAttribute('aria-checked', String(db.memory));

  sandbox.onOutput(({ kind, text }) => termLine(kind, text));

  els.connect?.addEventListener('click', connect);

  /* profile menu */
  els.profileBtn?.addEventListener('click', (e) => {
    e.stopPropagation();
    const open = !els.profileMenu.hidden;
    els.profileMenu.hidden = open;
    els.profileBtn.setAttribute('aria-expanded', String(!open));
  });
  document.addEventListener('click', (e) => {
    if (els.profileMenu && !els.profileMenu.hidden && !els.profileMenu.contains(e.target)) {
      els.profileMenu.hidden = true; els.profileBtn.setAttribute('aria-expanded', 'false');
    }
    if (els.modelMenu && !els.modelMenu.hidden) {
      els.modelMenu.hidden = true; els.modelBtn.setAttribute('aria-expanded', 'false');
    }
  });

  $('#memory-toggle')?.addEventListener('click', (e) => {
    db.memory = !db.memory; saveDb();
    e.currentTarget.setAttribute('aria-checked', String(db.memory));
  });
  $('#think-toggle')?.addEventListener('click', (e) => {
    db.think = !db.think; saveDb();
    e.currentTarget.setAttribute('aria-pressed', String(db.think));
    document.body.setAttribute('data-think', db.think ? 'on' : 'off');
  });
  $$('[data-theme-set]').forEach((b) => b.addEventListener('click', () => {
    db.theme = b.getAttribute('data-theme-set'); saveDb(); applyTheme();
  }));
  $('#run-diagnostics')?.addEventListener('click', () => { els.profileMenu.hidden = true; diagnostics(); });

  $('#chat-signout')?.addEventListener('click', async () => {
    await logout();
    db.run = null; saveDb();
    setPhase('signed-out');
    els.profileMenu.hidden = true;
  });

  /* model menu */
  els.modelBtn?.addEventListener('click', (e) => {
    e.stopPropagation();
    const open = !els.modelMenu.hidden;
    els.modelMenu.hidden = open;
    els.modelBtn.setAttribute('aria-expanded', String(!open));
  });

  /* conversations */
  $('#new-chat')?.addEventListener('click', () => {
    newConversation(); state.plan = []; paintPlan();
    renderConversation(); paintConversations();
    app.setAttribute('data-sidebar', 'closed'); syncScrim();
    els.input?.focus();
  });

  /* dock + drawers */
  $$('.dock-tab').forEach((t) => t.addEventListener('click', () => selectPanel(t.getAttribute('data-panel'))));
  els.dockToggle?.addEventListener('click', () => {
    const open = app.getAttribute('data-dock') !== 'closed';
    app.setAttribute('data-dock', open ? 'closed' : 'open');
    els.dockToggle.setAttribute('aria-pressed', String(!open));
    els.dockToggle.removeAttribute('data-active');
    if (!open) app.setAttribute('data-sidebar', 'closed');
    syncScrim();
  });
  $('#dock-close')?.addEventListener('click', () => {
    app.setAttribute('data-dock', 'closed');
    els.dockToggle?.setAttribute('aria-pressed', 'false'); syncScrim();
  });
  $('#sidebar-toggle')?.addEventListener('click', () => {
    const open = app.getAttribute('data-sidebar') === 'open';
    app.setAttribute('data-sidebar', open ? 'closed' : 'open');
    if (!open) app.setAttribute('data-dock', 'closed');
    syncScrim();
  });
  $('#sidebar-close')?.addEventListener('click', () => { app.setAttribute('data-sidebar', 'closed'); syncScrim(); });
  els.scrim?.addEventListener('click', () => {
    app.setAttribute('data-sidebar', 'closed'); app.setAttribute('data-dock', 'closed');
    els.dockToggle?.setAttribute('aria-pressed', 'false'); syncScrim();
  });
  window.addEventListener('resize', syncScrim);
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    app.setAttribute('data-sidebar', 'closed');
    if (els.profileMenu) els.profileMenu.hidden = true;
    if (els.modelMenu) els.modelMenu.hidden = true;
    syncScrim();
  });

  /* canvas editor */
  $('#editor-close')?.addEventListener('click', () => { els.editor.hidden = true; state.openFile = null; paintFiles(); });
  $('#editor-save')?.addEventListener('click', async () => {
    if (!state.openFile) return;
    const meta = state.files.get(state.openFile);
    if (!meta || meta.kind !== 'sandbox') return;
    await sandbox.writeFile(meta.path, els.editorArea.value);
    await syncFiles();
    termLine('ok', `saved ${state.openFile}`);
  });
  $('#editor-download')?.addEventListener('click', async () => {
    if (!state.openFile) return;
    const meta = state.files.get(state.openFile);
    if (meta.kind === 'image') {
      const b64 = meta.dataUrl.split(',')[1] || '';
      const bin = atob(b64); const arr = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i += 1) arr[i] = bin.charCodeAt(i);
      download(state.openFile, arr);
    } else {
      download(state.openFile, els.editorArea.value);
    }
  });
  $('#editor-delete')?.addEventListener('click', async () => {
    if (!state.openFile) return;
    const meta = state.files.get(state.openFile);
    if (meta?.kind === 'sandbox') { try { await sandbox.deleteFile(meta.path); } catch { /* gone */ } }
    state.files.delete(state.openFile);
    state.openFile = null; els.editor.hidden = true;
    await syncFiles(); paintFiles();
  });

  /* terminal input */
  $('#terminal-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const line = $('#terminal-input').value.trim();
    if (!line) return;
    $('#terminal-input').value = '';
    try { await sandbox.runCommand(line); } catch (err) { termLine('err', err.message); }
    await syncFiles();
  });

  /* composer */
  const autosize = () => {
    els.input.style.height = 'auto';
    els.input.style.height = Math.min(els.input.scrollHeight, 168) + 'px';
  };
  els.input?.addEventListener('input', autosize);
  els.input?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); }
  });
  autosize();
  els.form?.addEventListener('submit', (e) => { e.preventDefault(); submit(); });
  els.stop?.addEventListener('click', () => state.abort?.abort());

  els.fileInput?.addEventListener('change', async () => {
    for (const file of Array.from(els.fileInput.files || [])) {
      if (file.type.startsWith('image/')) {
        const reader = new FileReader();
        reader.onload = () => { state.attachments.push({ name: file.name, kind: 'image', dataUrl: String(reader.result) }); paintAttachments(); };
        reader.readAsDataURL(file);
      } else {
        state.attachments.push({ name: file.name, kind: 'file', bytes: new Uint8Array(await file.arrayBuffer()) });
        paintAttachments();
      }
    }
    els.fileInput.value = '';
  });

  $$('[data-prompt]').forEach((b) => b.addEventListener('click', () => {
    els.input.value = b.getAttribute('data-prompt');
    els.input.dispatchEvent(new Event('input'));
    submit();
  }));

  /* resume */
  $('#resume-yes')?.addEventListener('click', () => {
    els.resumeBar.hidden = true;
    send('Continue the plan from where it stopped. Check what is already done in the sandbox before repeating work.');
  });
  $('#resume-no')?.addEventListener('click', () => { els.resumeBar.hidden = true; db.run = null; saveDb(); });

  function submit() {
    const text = (els.input.value || '').trim();
    if (!text || state.running) return;
    els.input.value = ''; els.input.style.height = 'auto';
    send(text);
  }

  boot();
});
