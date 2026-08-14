/* ==========================================================================
   CorX Chat — the client.

   Auth: @openai-oauth/web (vendored, built unmodified from the published
   package). Messages stream from /api/chat over the visitor's own ChatGPT
   session. Tools run in a real Python VM in this tab (assets/js/sandbox.js),
   with internet access through /api/fetch.

   Nothing here is simulated. Every line in the terminal is a command that ran.
   ========================================================================== */
import {
  completeLogin,
  getSession,
  logout,
  openaiAuthHeaders,
  startLogin
} from '/assets/vendor/openai-oauth-web.js';

import * as sandbox from '/assets/js/sandbox.js';

const $ = (sel, root) => (root || document).querySelector(sel);
const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

const STORE = 'corx.chat.v1';
const FALLBACK_MODELS = ['gpt-5.1-codex', 'gpt-5.1-codex-mini'];
const MAX_TOOL_ROUNDS = 12;

const state = {
  model: null,
  models: [],
  messages: [],
  running: false,
  attachments: []   // {name, kind:'image'|'file', dataUrl?, text?}
};

const load = () => { try { return JSON.parse(localStorage.getItem(STORE)) || {}; } catch { return {}; } };
const save = (patch) => {
  try { localStorage.setItem(STORE, JSON.stringify({ ...load(), ...patch })); } catch { /* private mode */ }
};

/* ------------------------------------------------------------------ tools */
const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'run_python',
      description: 'Execute Python in the sandbox and return stdout plus the value of the last expression. State persists between calls. Use `import web` then `await web.get(url)` for internet access.',
      parameters: {
        type: 'object',
        properties: { code: { type: 'string', description: 'Python source to execute.' } },
        required: ['code']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'install_packages',
      description: 'Install Python packages into the sandbox with micropip. Pure-Python wheels and the packages Pyodide ships (numpy, pandas, matplotlib, requests-like shims) work.',
      parameters: {
        type: 'object',
        properties: { packages: { type: 'array', items: { type: 'string' } } },
        required: ['packages']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Write a text file into the sandbox working directory (/work).',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          content: { type: 'string' }
        },
        required: ['path', 'content']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read a text file from the sandbox.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'list_files',
      description: 'List files in the sandbox working directory.',
      parameters: { type: 'object', properties: { dir: { type: 'string' } } }
    }
  },
  {
    type: 'function',
    function: {
      name: 'web_search',
      description: 'Search the web and get back real results with titles, URLs and snippets. Use this whenever the answer depends on current information, or when you need to find a source rather than being given one.',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string' } },
        required: ['query']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'generate_image',
      description: 'Generate an image from a text prompt. The image is shown to the user and saved into the canvas for download.',
      parameters: {
        type: 'object',
        properties: {
          prompt: { type: 'string' },
          size: { type: 'string', enum: ['1024x1024', '1536x1024', '1024x1536'] }
        },
        required: ['prompt']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'deliver_file',
      description: 'Give a file from the sandbox to the user as a download. Use after building a file or a zip so they can actually take it away.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'fetch_url',
      description: 'Fetch a URL from the internet and return its text. Use this to read a page, check a fact against a live source, or call an API.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string' },
          method: { type: 'string', enum: ['GET', 'POST'] },
          body: { type: 'string' }
        },
        required: ['url']
      }
    }
  }
];

async function execTool(name, args) {
  switch (name) {
    case 'run_python':
      return (await sandbox.runPython(args.code || '')).output || '(no output)';
    case 'install_packages':
      return (await sandbox.installPackages(args.packages || [])).output;
    case 'write_file':
      return (await sandbox.writeFile(args.path, args.content ?? '')).output;
    case 'read_file':
      try { return await sandbox.readFile(args.path); }
      catch (e) { return e.message; }
    case 'list_files': {
      const files = await sandbox.listFiles(args.dir || undefined);
      refreshCanvasFromSandbox();
      return files.length ? files.map((f) => `${f.path} (${f.size}B)`).join('\n') : '(empty)';
    }
    case 'web_search': {
      const q = String(args.query || '').trim();
      termLine('cmd', `search "${q}"`);
      const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`);
      const data = await res.json().catch(() => ({}));
      const results = data.results || [];
      if (!results.length) {
        termLine('err', data.error || 'no results');
        return `No results${data.error ? ` (${data.error})` : ''}.`;
      }
      termLine('ok', `${results.length} results`);
      renderSources(results);
      return results
        .map((r, i) => `[${i + 1}] ${r.title}\n${r.url}\n${r.snippet}`)
        .join('\n\n');
    }

    case 'generate_image': {
      termLine('cmd', `image "${String(args.prompt || '').slice(0, 60)}"`);
      const res = await fetch('/api/image', {
        method: 'POST',
        headers: { ...(await openaiAuthHeaders()), 'content-type': 'application/json' },
        body: JSON.stringify({ prompt: args.prompt, size: args.size })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.image) {
        const msg = data.message || data.error || `image request failed (${res.status})`;
        termLine('err', msg);
        return `Image generation failed: ${msg}`;
      }
      termLine('ok', 'image generated');
      renderImage(data.image, args.prompt);
      const name = `image-${Date.now()}.png`;
      addCanvasEntry(name, async () => dataUrlToBytes(data.image), { lang: 'png', size: '—' });
      return `Image generated and shown to the user (saved to the canvas as ${name}).`;
    }

    case 'deliver_file': {
      const p = String(args.path || '');
      try {
        const bytes = await sandbox.readFile(p, true);
        const name = p.split('/').pop();
        download(name, bytes);
        termLine('ok', `delivered ${name}`);
        return `Delivered ${name} to the user as a download.`;
      } catch (err) {
        termLine('err', err.message);
        return err.message;
      }
    }

    case 'fetch_url': {
      termLine('cmd', `fetch ${args.url}`);
      const res = await fetch('/api/fetch', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url: args.url, method: args.method || 'GET', body: args.body })
      });
      const data = await res.json();
      if (data.error) { termLine('err', data.error); return `Error: ${data.error}`; }
      termLine('ok', `${data.status} ${args.url} — ${data.body.length} chars`);
      return `HTTP ${data.status}\n\n${String(data.body).slice(0, 12000)}`;
    }
    default:
      return `Unknown tool: ${name}`;
  }
}

/* Attach real search results to the message being written. */
function renderSources(results) {
  const node = currentNode;
  if (!node) return;
  const slot = $('.msg-tools', node);
  if (!slot) return;
  const box = document.createElement('div');
  box.className = 'sources';
  box.innerHTML =
    `<div class="sources-head">` +
    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m16.5 16.5 4 4"/></svg>` +
    `Searched the web · ${results.length} source${results.length === 1 ? '' : 's'}</div>` +
    `<div class="source-row"></div>`;
  const row = $('.source-row', box);
  for (const r of results) {
    const a = document.createElement('a');
    a.className = 'source';
    a.href = r.url;
    a.target = '_blank';
    a.rel = 'noopener nofollow';
    a.innerHTML =
      `<img class="favicon" alt="" width="16" height="16" loading="lazy" ` +
      `src="https://icons.duckduckgo.com/ip3/${encodeURIComponent(r.domain)}.ico">` +
      `<span>${esc(r.domain || r.title)}</span>`;
    row.appendChild(a);
  }
  slot.appendChild(box);
  scrollDown();
}

function renderImage(src, prompt) {
  const node = currentNode;
  if (!node) return;
  const slot = $('.msg-tools', node);
  if (!slot) return;
  const fig = document.createElement('figure');
  fig.className = 'gen-image';
  fig.innerHTML = `<img alt="${esc(prompt || 'Generated image')}" src="${esc(src)}">` +
    (prompt ? `<figcaption>${esc(prompt)}</figcaption>` : '');
  slot.appendChild(fig);
  scrollDown();
}

function dataUrlToBytes(dataUrl) {
  const b64 = String(dataUrl).split(',')[1] || '';
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

/* --------------------------------------------------------------- markdown */
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

function renderMarkdown(src) {
  const blocks = [];
  let text = String(src).replace(/```([\w.+-]*)\n?([\s\S]*?)```/g, (_, lang, code) => {
    blocks.push({ lang: lang || 'text', code: code.replace(/\n$/, '') });
    // Sentinel must survive trimming, so no leading/trailing spaces.
    return `\nCORXCODE${blocks.length - 1}\n`;
  });

  text = esc(text)
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');

  const out = [];
  let list = null;
  const closeList = () => { if (list) { out.push(`</${list}>`); list = null; } };

  for (const raw of text.split('\n')) {
    const line = raw.trimEnd();
    const ph = line.trim().match(/^CORXCODE(\d+)$/);
    if (ph) {
      closeList();
      const b = blocks[Number(ph[1])];
      out.push(`<pre data-lang="${esc(b.lang)}"><code>${esc(b.code)}</code></pre>`);
      continue;
    }
    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) { closeList(); out.push(`<h4>${h[2]}</h4>`); continue; }
    const ul = line.match(/^\s*[-*]\s+(.*)$/);
    const ol = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (ul || ol) {
      const want = ul ? 'ul' : 'ol';
      if (list !== want) { closeList(); out.push(`<${want}>`); list = want; }
      out.push(`<li>${(ul || ol)[1]}</li>`);
      continue;
    }
    closeList();
    if (line.trim()) out.push(`<p>${line}</p>`);
  }
  closeList();
  return { html: out.join('\n'), blocks };
}

/* Pull the model's reasoning block out so it can live in a dropdown. */
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
let currentNode = null;   // the assistant message tools render into
const setPhase = (p) => document.body.setAttribute('data-chat-phase', p);

function setStatus(msg, kind) {
  if (!els.status) return;
  els.status.textContent = msg || '';
  els.status.setAttribute('data-kind', kind || 'info');
  els.status.hidden = !msg;
}
const scrollDown = () => { if (els.thread) els.thread.scrollTop = els.thread.scrollHeight; };

function addMessage(role, html) {
  const wrap = document.createElement('div');
  wrap.className = `msg msg-${role}`;
  wrap.innerHTML =
    `<p class="msg-role">${role === 'user'
      ? '<span class="chat-avatar" aria-hidden="true">Y</span> You'
      : 'CorX Chat'}</p>` +
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
    slot.innerHTML =
      `<details class="think"><summary>` +
      `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3a6 6 0 0 0-3.5 10.9V17h7v-3.1A6 6 0 0 0 12 3z"/><path d="M9.5 20h5"/></svg>` +
      `<span class="think-label">Thinking…</span>` +
      `<span class="chev" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg></span>` +
      `</summary><div class="think-body"></div></details>`;
  }
  $('.think-body', slot).innerHTML = renderMarkdown(reasoning).html;
}

function finishReasoning(node, seconds) {
  const label = $('.think-label', node);
  if (label) label.textContent = `Thought for ${seconds} second${seconds === 1 ? '' : 's'}`;
}

/* --------------------------------------------------------------- terminal */
function termLine(kind, text) {
  if (!els.term) return;
  for (const line of String(text).split('\n')) {
    const div = document.createElement('div');
    div.className = kind;
    div.textContent = line;
    els.term.appendChild(div);
  }
  els.term.scrollTop = els.term.scrollHeight;
  if (els.termEmpty) els.termEmpty.hidden = true;
  if (els.dockTermTab) els.dockTermTab.setAttribute('data-active', 'true');
}

/* ----------------------------------------------------------------- canvas */
let canvasSeq = 0;
const canvasSeen = new Set();

function addCanvasEntry(name, getContent, meta) {
  if (canvasSeen.has(name)) return;
  canvasSeen.add(name);
  const row = document.createElement('button');
  row.type = 'button';
  row.className = 'canvas-file';
  row.innerHTML =
    `<span class="lang">${esc(meta.lang || 'txt')}</span> ${esc(name)}` +
    `<span class="size">${meta.size}</span>`;
  row.addEventListener('click', async () => download(name, await getContent()));
  els.canvas.appendChild(row);
  els.canvasEmpty.hidden = true;
  if (els.dockCount) els.dockCount.textContent = String(els.canvas.children.length);
}

function addBlocksToCanvas(blocks) {
  for (const b of blocks) {
    const first = b.code.split('\n')[0] || '';
    const named = first.match(/^(?:#|\/\/|<!--|--)\s*([\w./-]+\.[\w]+)/);
    const name = named ? named[1] : `snippet-${++canvasSeq}.${extFor(b.lang)}`;
    addCanvasEntry(name, async () => b.code, {
      lang: b.lang.slice(0, 6),
      size: `${(new Blob([b.code]).size / 1024).toFixed(1)} KB`
    });
  }
}

/* Files the sandbox actually produced belong in the canvas too. */
async function refreshCanvasFromSandbox() {
  if (!sandbox.isReady()) return;
  let files = [];
  try { files = await sandbox.listFiles(); } catch { return; }
  for (const f of files) {
    const name = f.path.replace(`${sandbox.workdir()}/`, '');
    addCanvasEntry(name, () => sandbox.readFile(f.path), {
      lang: (name.split('.').pop() || 'txt').slice(0, 6),
      size: `${(f.size / 1024).toFixed(1)} KB`
    });
  }
}

const extFor = (lang) => ({
  javascript: 'js', typescript: 'ts', python: 'py', bash: 'sh', shell: 'sh',
  html: 'html', css: 'css', json: 'json', markdown: 'md', text: 'txt'
}[String(lang).toLowerCase()] || (/^[a-z0-9]{1,5}$/i.test(lang) ? lang : 'txt'));

function download(name, content) {
  const blob = content instanceof Uint8Array
    ? new Blob([content])
    : new Blob([String(content)], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

/* ------------------------------------------------------------------- auth */
async function refreshModels() {
  try {
    const res = await fetch('/api/models', { headers: await openaiAuthHeaders() });
    if (!res.ok) throw new Error(String(res.status));
    const { models } = await res.json();
    if (Array.isArray(models) && models.length) state.models = models;
  } catch { state.models = FALLBACK_MODELS; }
  if (!state.models.length) state.models = FALLBACK_MODELS;
  const saved = load().model;
  state.model = state.models.includes(saved) ? saved : state.models[0];
  paintModels();
}

function paintModels() {
  if (!els.modelMenu) return;
  els.modelMenu.innerHTML = '';
  for (const id of state.models) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'model-opt';
    b.setAttribute('role', 'option');
    b.setAttribute('aria-selected', String(id === state.model));
    b.innerHTML = `<strong>${esc(id)}</strong><span class="check"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m4 12.5 5 5L20 6.5"/></svg></span>`;
    b.addEventListener('click', () => {
      state.model = id; save({ model: id }); paintModels();
      els.modelMenu.hidden = true;
      els.modelBtn.setAttribute('aria-expanded', 'false');
    });
    els.modelMenu.appendChild(b);
  }
  if (els.modelName) els.modelName.textContent = state.model || 'Model';
}

function restoreHistory() {
  const saved = load().history;
  if (!Array.isArray(saved) || !saved.length) return;
  state.messages = saved;
  for (const m of saved) {
    if (m.role === 'tool' || (m.role === 'assistant' && !m.content)) continue;
    const text = typeof m.content === 'string'
      ? m.content
      : (Array.isArray(m.content) ? m.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n') : '');
    if (!text) continue;
    const { reasoning, answer } = m.role === 'assistant'
      ? splitReasoning(text) : { reasoning: '', answer: text };
    const { html, blocks } = renderMarkdown(answer);
    const node = addMessage(m.role === 'user' ? 'user' : 'assistant', html);
    if (reasoning) { paintReasoning(node, reasoning); finishReasoning(node, 0); }
    if (m.role === 'assistant') addBlocksToCanvas(blocks);
  }
}

async function enterChat() {
  setPhase('ready');
  setStatus('');
  restoreHistory();
  await refreshModels();
  els.input?.focus();
}

async function boot() {
  setPhase('checking');
  try { await completeLogin(); }
  catch (err) { setStatus(`Sign-in did not complete: ${err.message}`, 'error'); }
  let session = null;
  try { session = await getSession(); } catch { session = null; }
  if (session) await enterChat();
  else setPhase('signed-out');
}

async function connect() {
  setStatus('Opening the ChatGPT sign-in…', 'info');
  els.connect.disabled = true;
  try {
    const result = await startLogin();
    if (result.status === 'needs-extension') {
      if (els.install) { els.install.href = result.installUrl; els.install.hidden = false; }
      setStatus('The “Sign in with ChatGPT” extension is required. Install it, then press Connect again.', 'warn');
    }
  } catch (err) {
    setStatus(`Could not start sign-in: ${err.message}`, 'error');
  } finally {
    els.connect.disabled = false;
  }
}

/* -------------------------------------------------------------- the agent */
async function streamOnce(node, startedAt) {
  const res = await fetch('/api/chat', {
    method: 'POST',
    headers: { ...(await openaiAuthHeaders()), 'content-type': 'application/json' },
    body: JSON.stringify({
      model: state.model,
      messages: state.messages,
      tools: TOOLS,
      locale: navigator.language || '',
      region: Intl.DateTimeFormat().resolvedOptions().timeZone || ''
    })
  });

  if (!res.ok) {
    const detail = await res.json().catch(() => ({}));
    if (res.status === 401) { setPhase('signed-out'); throw new Error('Your ChatGPT session expired. Connect again.'); }
    throw new Error(detail.message || `Request failed (${res.status}).`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const body = $('.msg-body', node);
  let buffer = '';
  let content = '';
  const calls = [];   // {id, name, args}

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
        let evt;
        try { evt = JSON.parse(raw); } catch { continue; }
        const delta = evt?.choices?.[0]?.delta;
        if (!delta) continue;

        if (delta.content) {
          content += delta.content;
          const { reasoning, answer } = splitReasoning(content);
          if (reasoning) paintReasoning(node, reasoning);
          body.innerHTML = answer
            ? renderMarkdown(answer).html
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
  if (reasoning) {
    paintReasoning(node, reasoning);
    finishReasoning(node, Math.max(1, Math.round((Date.now() - startedAt) / 1000)));
  }
  if (answer) {
    const { html, blocks } = renderMarkdown(answer);
    body.innerHTML = html;
    addBlocksToCanvas(blocks);
  } else if (!calls.length) {
    body.innerHTML = '<p>The model returned an empty response.</p>';
  }

  return { content, answer, calls: calls.filter(Boolean) };
}

async function runTurn() {
  const startedAt = Date.now();
  const node = addMessage('assistant', '<p class="typing"><span></span><span></span><span></span></p>');
  currentNode = node;
  const body = $('.msg-body', node);

  try {
    for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
      const { content, calls } = await streamOnce(node, startedAt);

      if (!calls.length) {
        state.messages.push({ role: 'assistant', content });
        break;
      }

      state.messages.push({
        role: 'assistant',
        content: content || null,
        tool_calls: calls.map((c) => ({
          id: c.id, type: 'function',
          function: { name: c.name, arguments: c.args || '{}' }
        }))
      });

      openDock('terminal');
      for (const call of calls) {
        let args = {};
        try { args = JSON.parse(call.args || '{}'); } catch { /* malformed */ }
        let output;
        try { output = await execTool(call.name, args); }
        catch (err) { output = `Tool error: ${err.message}`; }
        state.messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: String(output).slice(0, 20000)
        });
      }
      await refreshCanvasFromSandbox();

      // Keep a live placeholder while the next round streams.
      body.innerHTML = '<p class="typing"><span></span><span></span><span></span></p>';
    }
    save({ history: state.messages.slice(-60) });
  } catch (err) {
    body.innerHTML = `<p class="msg-error">${esc(err.message)}</p>`;
  }
}

async function send(text) {
  if (state.running) return;
  state.running = true;
  els.send.disabled = true;

  const images = state.attachments.filter((a) => a.kind === 'image');
  const files = state.attachments.filter((a) => a.kind === 'file');

  // Files go into the sandbox so the agent can actually open them.
  let notes = '';
  for (const f of files) {
    try {
      await sandbox.writeFile(f.name, f.bytes ? f.bytes : f.text);
      notes += `\n[Uploaded to the sandbox: /work/${f.name}]`;
    } catch (err) {
      notes += `\n[Could not stage ${f.name}: ${err.message}]`;
    }
  }

  const outbound = images.length
    ? [{ type: 'text', text: text + notes },
       ...images.map((a) => ({ type: 'image_url', image_url: { url: a.dataUrl } }))]
    : text + notes;

  state.messages.push({ role: 'user', content: outbound });

  const chips = state.attachments.length
    ? `<div class="attach-row">${state.attachments.map((a) => `<span class="attach">${esc(a.name)}</span>`).join('')}</div>`
    : '';
  addMessage('user', chips + renderMarkdown(text).html);

  state.attachments = [];
  paintAttachments();
  await refreshCanvasFromSandbox();

  await runTurn();

  state.running = false;
  els.send.disabled = false;
  scrollDown();
}

function paintAttachments() {
  if (!els.attachRow) return;
  els.attachRow.innerHTML = '';
  els.attachRow.hidden = !state.attachments.length;
  state.attachments.forEach((a, i) => {
    const chip = document.createElement('span');
    chip.className = 'attach';
    chip.innerHTML = `${esc(a.name)} <button type="button" aria-label="Remove attachment">&times;</button>`;
    $('button', chip).addEventListener('click', () => {
      state.attachments.splice(i, 1);
      paintAttachments();
    });
    els.attachRow.appendChild(chip);
  });
}

function openDock(panel) {
  const app = $('#chat-app');
  if (!app) return;
  app.setAttribute('data-dock', 'open');
  app.setAttribute('data-sidebar', 'closed');
  if (els.dockToggle) els.dockToggle.setAttribute('aria-pressed', 'true');
  if (els.scrim) {
    els.scrim.hidden = !window.matchMedia('(max-width: 1100px)').matches;
  }
  if (panel) {
    $$('.dock-tab', app).forEach((t) => t.setAttribute('aria-selected', String(t.getAttribute('data-panel') === panel)));
    $$('.dock-panel', app).forEach((p) => { p.hidden = p.getAttribute('data-panel') !== panel; });
  }
}

/* ------------------------------------------------------------------- init */
document.addEventListener('DOMContentLoaded', () => {
  const app = $('#chat-app');
  if (!app) return;

  Object.assign(els, {
    thread: $('.chat-thread', app),
    threadInner: $('.chat-thread-inner', app),
    empty: $('#chat-empty', app),
    input: $('#composer-input', app),
    form: $('#composer-form', app),
    send: $('#composer-send', app),
    status: $('#chat-status'),
    connect: $('#chat-connect'),
    install: $('#chat-install'),
    signout: $('#chat-signout', app),
    modelBtn: $('.model-btn', app),
    modelName: $('.model-name', app),
    modelMenu: $('.model-menu', app),
    canvas: $('#canvas-list', app),
    canvasEmpty: $('#canvas-empty', app),
    dockCount: $('#dock-count', app),
    dockToggle: $('#dock-toggle', app),
    dockTermTab: $('.dock-tab[data-panel="terminal"]', app),
    term: $('#terminal-out', app),
    termEmpty: $('#terminal-empty', app),
    termForm: $('#terminal-form', app),
    termInput: $('#terminal-input', app),
    attachRow: $('#composer-attachments', app),
    fileInput: $('#composer-file', app),
    newChat: $('.chat-new', app),
    scrim: $('#chat-scrim', app)
  });

  sandbox.onOutput(({ kind, text }) => termLine(kind, text));

  els.connect?.addEventListener('click', connect);

  els.signout?.addEventListener('click', async () => {
    await logout();
    save({ history: [] });
    state.messages = [];
    els.threadInner.innerHTML = '';
    if (els.empty) els.empty.hidden = false;
    setPhase('signed-out');
  });

  if (els.modelBtn) {
    els.modelBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const open = !els.modelMenu.hidden;
      els.modelMenu.hidden = open;
      els.modelBtn.setAttribute('aria-expanded', String(!open));
    });
    document.addEventListener('click', () => {
      if (els.modelMenu && !els.modelMenu.hidden) {
        els.modelMenu.hidden = true;
        els.modelBtn.setAttribute('aria-expanded', 'false');
      }
    });
  }

  $$('.dock-tab', app).forEach((tab) => {
    tab.addEventListener('click', () => openDock(tab.getAttribute('data-panel')));
  });

  const closeOverlays = () => {
    app.setAttribute('data-sidebar', 'closed');
    app.setAttribute('data-dock', 'closed');
    els.dockToggle?.setAttribute('aria-pressed', 'false');
    if (els.scrim) els.scrim.hidden = true;
  };
  const syncScrim = () => {
    if (!els.scrim) return;
    const overlaid = app.getAttribute('data-sidebar') === 'open' || app.getAttribute('data-dock') === 'open';
    els.scrim.hidden = !(overlaid && window.matchMedia('(max-width: 1100px)').matches);
  };

  $('#sidebar-toggle', app)?.addEventListener('click', () => {
    const open = app.getAttribute('data-sidebar') === 'open';
    app.setAttribute('data-sidebar', open ? 'closed' : 'open');
    if (!open) app.setAttribute('data-dock', 'closed');
    syncScrim();
  });
  els.scrim?.addEventListener('click', closeOverlays);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeOverlays(); });
  window.addEventListener('resize', syncScrim);

  els.dockToggle?.addEventListener('click', () => {
    const open = app.getAttribute('data-dock') !== 'closed';
    app.setAttribute('data-dock', open ? 'closed' : 'open');
    els.dockToggle.setAttribute('aria-pressed', String(!open));
    if (!open) app.setAttribute('data-sidebar', 'closed');
    syncScrim();
  });
  $('#dock-close', app)?.addEventListener('click', () => {
    app.setAttribute('data-dock', 'closed');
    els.dockToggle?.setAttribute('aria-pressed', 'false');
    syncScrim();
  });

  // Manual terminal — you can drive the sandbox yourself.
  els.termForm?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const line = els.termInput.value.trim();
    if (!line) return;
    els.termInput.value = '';
    try { await sandbox.runCommand(line); }
    catch (err) { termLine('err', err.message); }
    await refreshCanvasFromSandbox();
  });

  if (els.input) {
    const autosize = () => {
      els.input.style.height = 'auto';
      els.input.style.height = Math.min(els.input.scrollHeight, 168) + 'px';
    };
    els.input.addEventListener('input', autosize);
    els.input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); }
    });
    autosize();
  }
  els.form?.addEventListener('submit', (e) => { e.preventDefault(); submit(); });

  els.fileInput?.addEventListener('change', async () => {
    for (const file of Array.from(els.fileInput.files || [])) {
      if (file.type.startsWith('image/')) {
        const reader = new FileReader();
        reader.onload = () => {
          state.attachments.push({ name: file.name, kind: 'image', dataUrl: String(reader.result) });
          paintAttachments();
        };
        reader.readAsDataURL(file);
      } else {
        const bytes = new Uint8Array(await file.arrayBuffer());
        state.attachments.push({ name: file.name, kind: 'file', bytes });
        paintAttachments();
      }
    }
    els.fileInput.value = '';
  });

  els.newChat?.addEventListener('click', () => {
    app.setAttribute('data-sidebar', 'closed');
    if (els.scrim) els.scrim.hidden = true;
    state.messages = [];
    save({ history: [] });
    els.threadInner.innerHTML = '';
    if (els.empty) els.empty.hidden = false;
    els.input?.focus();
  });

  $$('[data-prompt]').forEach((btn) => {
    btn.addEventListener('click', () => {
      els.input.value = btn.getAttribute('data-prompt');
      els.input.dispatchEvent(new Event('input'));
      submit();
    });
  });

  function submit() {
    const text = (els.input.value || '').trim();
    if (!text || state.running) return;
    els.input.value = '';
    els.input.style.height = 'auto';
    send(text);
  }

  boot();
});
