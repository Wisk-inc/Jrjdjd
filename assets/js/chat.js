/* ==========================================================================
   CorX Chat — chat + browser agent for CorX3.8-27B.

   The model runs on CorX Labs' own OpenAI-compatible endpoint (keyless, CORS
   on), so the browser calls it directly — no proxy, no key by default. It is
   a plain completions server with no native tool-calling, so every reply is
   taught a small text protocol in the system prompt (always on, no toggle
   needed) and this file parses tool calls out of its reply. Tools run for
   real, on every message:
     - run_python / write_file / read_file / delete_file / list_files /
       install_packages / deliver_file execute in an actual Python sandbox in
       this tab (sandbox.js — CPython compiled to WebAssembly). Nothing here
       is simulated: what the terminal shows is what happened.
     - web_search and fetch_url call /api/search and /api/fetch, two small
       edge functions that proxy DuckDuckGo and arbitrary URLs so the browser
       is not blocked by CORS. No key, no quota.
     - search_memory greps this browser's other saved conversations.
   ========================================================================== */

import * as sandbox from '/assets/js/sandbox.js';

const DEFAULTS = {
  // The current CorX3.8 endpoint. The quick-tunnel URL changes whenever the
  // notebook restarts — update it here or in the Settings dialog.
  endpoint: 'https://exercise-fog-automatically-joel.trycloudflare.com',
  apiKey: '',
  model: 'corx3.8'
};
const STORE = 'corx.chat.v3';
const OLD_STORE = 'corx.chat.direct';
const MAX_CONVS = 30;
const MAX_MESSAGES = 80;

const $ = (s, r) => (r || document).querySelector(s);
const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* -------------------------------------------------------------- effort levels
   Each level changes real parameters, not just a label: how many tokens the
   model is allowed, how many tool-call rounds the agent gets before it must
   stop, how many sources a search pulls back, and whether it is told to
   verify and re-check its own work. Higher effort takes longer and costs
   more tokens on purpose — that is the trade the user is making. */
const EFFORT = {
  low:    { label: 'Low',    maxTokens: 512,  temperature: 0.7,  rounds: 3,  searchN: 3,
            hint: 'Keep your reasoning short. Answer directly.' },
  medium: { label: 'Medium', maxTokens: 1024, temperature: 0.7,  rounds: 5,  searchN: 4,
            hint: 'Think briefly in a <think> block first if the question needs it.' },
  high:   { label: 'High',   maxTokens: 2048, temperature: 0.65, rounds: 8,  searchN: 6,
            hint: 'Think step by step in a <think> block before answering. Break the problem into parts.' },
  extra:  { label: 'Extra',  maxTokens: 3072, temperature: 0.6,  rounds: 12, searchN: 8,
            hint: 'Think carefully and step by step in a <think> block. Consider more than one approach, check your own reasoning for mistakes, and search when you are not sure of something.' },
  max:    { label: 'Max',    maxTokens: 4096, temperature: 0.55, rounds: 18, searchN: 10,
            hint: 'Think exhaustively in a <think> block: break the problem into parts, weigh alternative approaches, verify each step, search liberally for anything you are not fully sure of, and re-check any fix before you say you are done. Use as many tool calls as the task genuinely needs.' }
};

/* ------------------------------------------------------------------ store */
function migrate() {
  try {
    const old = JSON.parse(localStorage.getItem(OLD_STORE) || 'null');
    if (old && !localStorage.getItem(STORE)) {
      return { endpoint: old.endpoint, apiKey: old.apiKey, model: old.model };
    }
  } catch { /* ignore */ }
  return {};
}
function defaults() {
  return {
    ...DEFAULTS, ...migrate(),
    profile: { name: '', avatar: '' },
    effort: 'medium',
    memory: true,
    conversations: [],
    activeId: null
  };
}
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
        ...c, messages: c.messages.slice(-MAX_MESSAGES)
      }))
    };
    localStorage.setItem(STORE, JSON.stringify(trimmed));
  } catch { /* quota or private mode */ }
}
const base = () => db.endpoint.replace(/\/+$/, '').replace(/\/v1$/, '');
const activeConv = () => db.conversations.find((c) => c.id === db.activeId) || null;
function newConversation() {
  const conv = {
    id: `c${Date.now()}`, title: 'New chat', updated: Date.now(),
    effort: db.effort, messages: [], plan: [], run: null
  };
  db.conversations.unshift(conv);
  db.activeId = conv.id;
  saveDb();
  return conv;
}

/* -------------------------------------------------------------- system prompt */
function buildSystem(conv) {
  const eff = EFFORT[conv.effort] || EFFORT.medium;
  const name = db.profile.name ? ` The user's name is ${db.profile.name}.` : '';
  const base = `You are Corx, a helpful Jamaican AI assistant made by CorX Labs. You speak Jamaican Patois by default and switch to standard English when the user writes in English or asks you to. Answer directly and honestly.${name}\n\n${eff.hint}`;

  return `${base}

You always have a real Python sandbox in the user's browser and real internet access — these are not optional extras, use them whenever they would help, without asking permission first. Use tools by writing a line in EXACTLY this form, on its own line:

<tool>{"name": "TOOL_NAME", "arguments": { ... }}</tool>

You may call several tools in one reply. After they run, you will be shown their results and can continue. When the task is done, reply normally with no tool line.

Tools:
- set_plan {"steps": ["step one", ...]} — publish a checklist first for any job with more than two steps. The user watches this live.
- complete_step {"index": 0} — mark a plan step done (zero-based).
- run_python {"code": "..."} — run Python. State persists between calls. You get back exactly what it printed. To read or edit an uploaded .zip, use Python's zipfile module, e.g. zipfile.ZipFile('/work/name.zip').
- write_file {"path": "name.py", "content": "..."} — create or overwrite a text file in /work.
- read_file {"path": "name.py"} — read a file back.
- delete_file {"path": "name.py"} — delete a file.
- list_files {} — list files in /work.
- install_packages {"packages": ["numpy"]} — install Python packages with micropip.
- deliver_file {"path": "name.zip"} — hand a sandbox file to the user as a download.
- web_search {"query": "...", "n": ${eff.searchN}} — real web search, up to n results with titles, URLs and snippets. Call this yourself whenever the answer depends on information you might not know, might be out of date, or the user asks about something current — do not ask permission first.
- fetch_url {"url": "https://..."} — read a page's actual content (including any code shown on it). Use this after web_search to read the most relevant result before answering, especially for anything technical.
- search_memory {"query": "..."} — search the user's OTHER saved conversations in this browser for relevant earlier context. Use it when the user references something from before, or when it would help to recall what they already told you.

Rules:
- Never say you cannot do something a tool covers (search, running code, reading a page, remembering another chat). Call the tool instead.
- Actually run the code before claiming a result — the user can see every command.
- Before you run code you just wrote, look it over in your <think> block first: check the logic, edge cases and syntax, and fix anything you spot — don't wait for it to fail first.
- If run_python errors anyway, read the traceback and try to fix it yourself on your next call before reporting the error to the user.
- When you search, read more than one source if they might disagree, and say plainly if sources conflict rather than picking one silently.
- Put final code or output in normal markdown for the user. Keep the Patois voice, but tool lines must be exact JSON.`;
}

/* -------------------------------------------------------------- tiny markdown */
function renderMarkdown(src) {
  const blocks = [];
  let text = String(src).replace(/```([\w.+-]*)\n?([\s\S]*?)```/g, (_, lang, code) => {
    blocks.push(code.replace(/\n$/, ''));
    return `\nCORXCODE${blocks.length - 1}\n`;
  });
  text = esc(text)
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');

  const out = []; let list = null;
  const closeList = () => { if (list) { out.push(`</${list}>`); list = null; } };
  for (const raw of text.split('\n')) {
    const line = raw.trimEnd();
    const ph = line.trim().match(/^CORXCODE(\d+)$/);
    if (ph) { closeList(); out.push(`<pre><code>${esc(blocks[+ph[1]])}</code></pre>`); continue; }
    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) { closeList(); out.push(`<h4>${line.replace(/^#{1,4}\s+/, '')}</h4>`); continue; }
    const ul = line.match(/^\s*[-*]\s+(.*)$/);
    const ol = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (ul || ol) {
      const want = ul ? 'ul' : 'ol';
      if (list !== want) { closeList(); out.push(`<${want}>`); list = want; }
      out.push(`<li>${(ul || ol)[1]}</li>`); continue;
    }
    closeList();
    if (line.trim()) out.push(`<p>${line}</p>`);
  }
  closeList();
  return out.join('\n');
}

/* Split reasoning (<think>) and strip tool lines / synthetic scaffolding from
   what the user sees. */
function splitThinking(text) {
  const m = String(text).match(/<think>([\s\S]*?)(<\/think>|$)/i);
  const reasoning = m ? m[1].trim() : '';
  let answer = String(text).replace(/<think>[\s\S]*?(<\/think>|$)/i, '');
  answer = answer.replace(/<tool>[\s\S]*?<\/tool>/gi, '').replace(/```tool\s*[\s\S]*?```/gi, '').trim();
  return { reasoning, answer };
}

/* Pull tool calls out of a completed assistant message. */
function parseToolCalls(text) {
  const calls = [];
  const push = (raw) => {
    try {
      const obj = JSON.parse(raw.trim());
      if (obj && typeof obj.name === 'string') calls.push({ name: obj.name, args: obj.arguments || obj.args || {} });
    } catch { /* ignore malformed */ }
  };
  const re1 = /<tool>([\s\S]*?)<\/tool>/gi; let m;
  while ((m = re1.exec(text))) push(m[1]);
  const re2 = /```tool\s*([\s\S]*?)```/gi;
  while ((m = re2.exec(text))) push(m[1]);
  return calls;
}

/* Strip an HTML page down to readable text for the model. */
function htmlToText(html) {
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6]|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'")
    .replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n\n')
    .trim();
}

/* --------------------------------------------------------------------- view */
const els = {};
let running = false;
let abort = null;
let currentTools = null;
const state = { attachments: new Set(), files: new Map(), openFile: null };

function scrollDown() { els.thread.scrollTop = els.thread.scrollHeight; }

function addRow(role, html, opts = {}) {
  const wrap = document.createElement('div');
  wrap.className = `msg msg-${role}`;
  const initial = (db.profile.name || 'Y')[0].toUpperCase();
  const who = role === 'user'
    ? (db.profile.avatar
        ? `<img class="avatar" alt="" src="${db.profile.avatar}">`
        : `<span class="avatar" aria-hidden="true">${esc(initial)}</span>`) + ` ${esc(db.profile.name || 'You')}`
    : '<span class="avatar" aria-hidden="true">C</span> CorX3.8';
  wrap.innerHTML = `<p class="who">${who}</p>` +
    (role === 'assistant' ? '<div class="msg-reasoning"></div><div class="msg-tools"></div>' : '') +
    '<div class="bubble"></div>';
  $('.bubble', wrap).innerHTML = html;
  if (els.empty && els.empty.parentElement) { els.empty.hidden = true; }
  els.thread.appendChild(wrap);
  scrollDown();
  if (role === 'assistant') currentTools = $('.msg-tools', wrap);
  if (opts.synthetic) wrap.hidden = true;
  return $('.bubble', wrap);
}

function paintReasoning(bubble, reasoning, seconds) {
  const msg = bubble.closest('.msg');
  const slot = msg ? $('.msg-reasoning', msg) : null;
  if (!slot || !reasoning) return;
  if (!$('details', slot)) {
    slot.innerHTML = '<details class="think"><summary>' +
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3a6 6 0 0 0-3.5 10.9V17h7v-3.1A6 6 0 0 0 12 3z"/><path d="M9.5 20h5"/></svg>' +
      '<span class="think-label">Thinking…</span>' +
      '<span class="chev" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg></span>' +
      '</summary><div class="think-body"></div></details>';
  }
  $('.think-body', slot).innerHTML = renderMarkdown(reasoning);
  if (seconds != null) {
    $('.think-label', slot).textContent = `Thought for ${seconds} second${seconds === 1 ? '' : 's'}`;
  }
}

function setRunning(on) {
  running = on;
  els.send.hidden = on;
  els.stop.hidden = !on;
}

/* tool cards, inline in the conversation */
const TOOL_LABEL = {
  set_plan: 'Planning', complete_step: 'Step done', run_python: 'Running Python',
  write_file: 'Writing', read_file: 'Reading', delete_file: 'Deleting',
  list_files: 'Listing files', install_packages: 'Installing', deliver_file: 'Delivering',
  web_search: 'Searching the web', fetch_url: 'Reading a page', search_memory: 'Recalling memory'
};
function addToolCard(name, args) {
  if (!currentTools) return null;
  const card = document.createElement('div');
  card.className = 'tool-card';
  card.setAttribute('data-state', 'running');
  const arg = args.path || args.query || args.url || (args.packages || []).join(' ') ||
    (args.code ? args.code.split('\n')[0] : '') || (args.steps ? `${args.steps.length} steps` : '');
  card.innerHTML = '<div class="tool-head">' +
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m8 9-3 3 3 3M16 9l3 3-3 3"/></svg>' +
    `<span class="tool-name">${esc(TOOL_LABEL[name] || name)}</span>` +
    `<span class="tool-arg">${esc(String(arg).slice(0, 100))}</span>` +
    '<span class="tool-state">Running</span></div>';
  currentTools.appendChild(card);
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

/* search animation + sources dropdown */
const SEARCH_DOMAINS = ['wikipedia.org', 'github.com', 'nature.com', 'reuters.com', 'arxiv.org', 'bbc.com'];
function showSearchStrip(query) {
  if (!currentTools) return null;
  const strip = document.createElement('div');
  strip.className = 'search-strip';
  strip.innerHTML = `<span class="label">Searching &ldquo;${esc(String(query).slice(0, 44))}&rdquo;</span>` +
    `<span class="track">${SEARCH_DOMAINS.concat(SEARCH_DOMAINS).map((d) =>
      `<img class="favicon" alt="" src="https://icons.duckduckgo.com/ip3/${d}.ico">`).join('')}</span>`;
  currentTools.appendChild(strip);
  scrollDown();
  return strip;
}
function renderSources(results) {
  if (!currentTools || !results.length) return;
  const box = document.createElement('details');
  box.className = 'sources';
  box.innerHTML = `<summary><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m16.5 16.5 4 4"/></svg>` +
    `Searched the web &middot; ${results.length} source${results.length === 1 ? '' : 's'}` +
    `<span class="chev" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg></span></summary>` +
    '<div class="source-list"></div>';
  const list = $('.source-list', box);
  for (const r of results) {
    const a = document.createElement('a');
    a.className = 'source-row'; a.href = r.url; a.target = '_blank'; a.rel = 'noopener nofollow';
    a.innerHTML = `<img class="favicon" alt="" width="16" height="16" loading="lazy" src="https://icons.duckduckgo.com/ip3/${encodeURIComponent(r.domain)}.ico">` +
      `<span class="src-text"><strong>${esc(r.title)}</strong><small>${esc(r.domain)}</small>${r.snippet ? `<small class="snippet">${esc(r.snippet)}</small>` : ''}</span>`;
    list.appendChild(a);
  }
  currentTools.appendChild(box);
  scrollDown();
}

/* ------------------------------------------------------------------ health */
async function checkHealth() {
  setStatus('checking', 'Checking…');
  try {
    const res = await fetch(`${base()}/health`, { method: 'GET' });
    if (!res.ok) throw new Error(String(res.status));
    const j = await res.json().catch(() => ({}));
    setStatus('ok', j.busy ? 'Online · busy' : 'Online');
  } catch {
    setStatus('down', 'Offline');
  }
}
function setStatus(stateName, label) {
  els.status.setAttribute('data-state', stateName);
  $('.status-label', els.status).textContent = label;
}

/* ------------------------------------------------------------- tool runners */
async function execTool(name, args, conv) {
  switch (name) {
    case 'set_plan':
      conv.plan = (args.steps || []).map((t) => ({ text: String(t), state: 'todo' }));
      if (conv.plan[0]) conv.plan[0].state = 'active';
      paintPlan(conv); markPanel('plan');
      return `Plan set with ${conv.plan.length} steps.`;
    case 'complete_step': {
      const i = Number(args.index);
      if (conv.plan[i]) conv.plan[i].state = 'done';
      const next = conv.plan.find((s) => s.state === 'todo');
      if (next) next.state = 'active';
      paintPlan(conv);
      return `Step ${i + 1} done.`;
    }
    case 'run_python': {
      openDock('terminal');
      const r = await sandbox.runPython(args.code || '');
      await syncFiles();
      if (!r.ok) throw new Error(r.output || 'Python raised an error with no message.');
      return r.output || '(no output)';
    }
    case 'install_packages': {
      openDock('terminal');
      const r = await sandbox.installPackages(args.packages || []);
      if (!r.ok) throw new Error(r.output || 'Package install failed.');
      return r.output;
    }
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
    case 'deliver_file': {
      try {
        const bytes = await sandbox.readFile(String(args.path), true);
        const name = String(args.path).split('/').pop();
        download(name, bytes);
        return `Delivered ${name} as a download.`;
      } catch (e) { return e.message; }
    }
    case 'web_search': {
      const q = String(args.query || '').trim();
      const n = Math.min(Math.max(1, Number(args.n) || EFFORT[conv.effort]?.searchN || 5), 15);
      const strip = showSearchStrip(q);
      termLine('cmd', `search "${q}" (${n})`);
      let data;
      try {
        const res = await fetch(`/api/search?q=${encodeURIComponent(q)}&n=${n}`);
        data = await res.json();
      } catch (e) { data = { error: e.message, results: [] }; }
      strip?.remove();
      const results = data.results || [];
      if (!results.length) { termLine('err', data.error || 'no results'); return `No results${data.error ? ` (${data.error})` : ''}.`; }
      termLine('ok', `${results.length} results`);
      renderSources(results);
      return results.map((r, i) => `[${i + 1}] ${r.title}\n${r.url}\n${r.snippet}`).join('\n\n');
    }
    case 'fetch_url': {
      termLine('cmd', `fetch ${args.url}`);
      let data;
      try {
        const res = await fetch('/api/fetch', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ url: args.url, method: 'GET' })
        });
        data = await res.json();
      } catch (e) { data = { error: e.message }; }
      if (data.error) { termLine('err', data.error); return `Error: ${data.error}`; }
      const text = /text\/html/i.test(data.headers?.['content-type'] || '') ? htmlToText(data.body) : data.body;
      termLine('ok', `${data.status} — ${text.length} chars`);
      return `HTTP ${data.status} — ${args.url}\n\n${text.slice(0, 12000)}`;
    }
    case 'search_memory': {
      const q = String(args.query || '').toLowerCase().trim();
      if (!q) return 'No query given.';
      const hits = [];
      for (const c of db.conversations) {
        if (c.id === conv.id) continue;
        for (const m of c.messages) {
          if (m.synthetic || m.role === 'system') continue;
          const text = typeof m.content === 'string' ? m.content : '';
          if (text.toLowerCase().includes(q)) hits.push(`[${c.title}] ${m.role}: ${text.slice(0, 300)}`);
        }
      }
      return hits.length ? hits.slice(0, 12).join('\n\n') : '(nothing found in other saved chats)';
    }
    default:
      return `Unknown tool: ${name}`;
  }
}

/* -------------------------------------------------------------- one API call */
async function streamOnce(conv, bubble) {
  abort = new AbortController();
  const headers = { 'content-type': 'application/json' };
  if (db.apiKey) headers.authorization = `Bearer ${db.apiKey}`;
  const eff = EFFORT[conv.effort] || EFFORT.medium;

  const payload = [{ role: 'system', content: buildSystem(conv) },
    ...conv.messages.map((m) => ({ role: m.role, content: m.content }))];

  const res = await fetch(`${base()}/v1/chat/completions`, {
    method: 'POST', signal: abort.signal, headers,
    body: JSON.stringify({
      model: db.model || 'corx3.8', messages: payload, stream: true,
      max_tokens: eff.maxTokens, temperature: eff.temperature
    })
  });

  if (!res.ok) {
    let detail = '';
    try { const j = await res.json(); detail = j.detail || j.error?.message || ''; }
    catch { detail = await res.text().catch(() => ''); }
    throw new Error(`Server returned ${res.status}${detail ? ` — ${String(detail).slice(0, 200)}` : ''}`);
  }
  if (!res.body) throw new Error('No response stream.');

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '', acc = '';
  const startedAt = Date.now();
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
        const delta = evt?.choices?.[0]?.delta?.content;
        if (delta) {
          acc += delta;
          const { reasoning, answer } = splitThinking(acc);
          if (reasoning) paintReasoning(bubble, reasoning);
          bubble.innerHTML = answer ? renderMarkdown(answer)
            : '<p class="typing"><span></span><span></span><span></span></p>';
          scrollDown();
        }
      }
    }
  }
  const { reasoning } = splitThinking(acc);
  if (reasoning) paintReasoning(bubble, reasoning, Math.max(1, Math.round((Date.now() - startedAt) / 1000)));
  return acc;
}

/* --------------------------------------------------------------------- send */
async function send(text, opts = {}) {
  if (running || !text.trim()) return;
  const conv = activeConv() || newConversation();
  if (!opts.silent) {
    if (conv.title === 'New chat') { conv.title = text.slice(0, 46) + (text.length > 46 ? '…' : ''); paintConversations(); }
    let userContent = text;
    if (state.attachments.size) userContent += '\n\n[Uploaded to the sandbox at /work: ' + [...state.attachments].join(', ') + ']';
    const chips = state.attachments.size
      ? `<div class="attach-row">${[...state.attachments].map((n) => `<span class="attach">${esc(n)}</span>`).join('')}</div>` : '';
    conv.messages.push({ role: 'user', content: userContent });
    addRow('user', chips + renderMarkdown(text));
    state.attachments.clear(); paintAttachments();
  } else {
    conv.messages.push({ role: 'user', content: text, synthetic: true });
  }

  conv.run = { active: true };
  saveDb();
  setRunning(true);
  let bubble = addRow('assistant', '<p class="typing"><span></span><span></span><span></span></p>');
  const eff = EFFORT[conv.effort] || EFFORT.medium;

  try {
    for (let round = 0; round < eff.rounds; round += 1) {
      const reply = await streamOnce(conv, bubble);
      const calls = parseToolCalls(reply);
      const { answer } = splitThinking(reply);
      if (answer) {
        bubble.innerHTML = renderMarkdown(answer);
      } else if (calls.length) {
        // A tool-only round has nothing to show in the trailing bubble — the
        // tool cards above it (already in this row's .msg-tools) are the
        // visible record. Leaving the "typing…" spinner here would just sit
        // frozen forever, so drop it rather than fake an answer.
        bubble.remove();
      } else {
        bubble.innerHTML = '<p>(empty response)</p>';
      }

      conv.messages.push({ role: 'assistant', content: reply });
      if (!calls.length) { setStatus('ok', 'Online'); break; }

      const results = [];
      for (const call of calls) {
        const card = addToolCard(call.name, call.args);
        let out, failed = false;
        try { out = await execTool(call.name, call.args, conv); }
        catch (e) { out = `Tool error: ${e.message}`; failed = true; }
        finishToolCard(card, out, failed);
        results.push(`[${call.name}] ->\n${String(out).slice(0, 6000)}`);
      }
      conv.messages.push({
        role: 'user', synthetic: true,
        content: 'Tool results:\n\n' + results.join('\n\n') + '\n\nContinue, or give the final answer if the task is done.'
      });
      bubble = addRow('assistant', '<p class="typing"><span></span><span></span><span></span></p>');
    }
  } catch (err) {
    if (err.name === 'AbortError') {
      bubble.innerHTML = bubble.innerHTML.includes('typing') ? '<p><em>Stopped.</em></p>' : bubble.innerHTML + '<p><em>Stopped.</em></p>';
    } else {
      bubble.closest('.msg').classList.add('msg-error');
      bubble.innerHTML = `<p>${esc(err.message)}</p>` +
        '<p style="margin-top:8px;font-size:.85rem">Can’t reach CorX3.8. The model server may be ' +
        'offline, or its address may have changed — open <strong>Settings</strong> to update the ' +
        'endpoint, or the <a href="/chat/documentation/">set-up guide</a>.</p>';
      checkHealth();
    }
  } finally {
    conv.run = null; conv.updated = Date.now();
    saveDb(); paintConversations();
    setRunning(false);
    els.input.focus();
  }
}

/* ---------------------------------------------------------- conversations */
function paintConversations() {
  if (!els.convList) return;
  els.convList.innerHTML = '';
  if (!db.conversations.length) {
    els.convList.innerHTML = '<p class="panel-empty" style="padding:8px 4px">No saved chats yet.</p>';
    return;
  }
  for (const c of db.conversations) {
    const row = document.createElement('div');
    row.className = 'conv';
    row.setAttribute('aria-current', String(c.id === db.activeId));
    row.innerHTML = `<span class="conv-title">${esc(c.title)}</span>` +
      '<button class="conv-del" type="button" aria-label="Delete chat"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M5 7h14M10 7V5h4v2M8 7l1 12h6l1-12"/></svg></button>';
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
  closeSidebar();
}
function renderConversation() {
  els.thread.innerHTML = '';
  els.thread.appendChild(els.empty);
  const conv = activeConv();
  els.empty.hidden = Boolean(conv && conv.messages.some((m) => !m.synthetic));
  els.effortSel.value = conv?.effort || 'medium';
  paintPlan(conv || { plan: [] });
  if (!conv) return;
  for (const m of conv.messages) {
    if (m.synthetic || m.role === 'system') continue;
    const text = typeof m.content === 'string' ? m.content : '';
    if (!text) continue;
    if (m.role === 'user') { addRow('user', renderMarkdown(text)); continue; }
    const { reasoning, answer } = splitThinking(text);
    const bubble = addRow('assistant', renderMarkdown(answer));
    if (reasoning) paintReasoning(bubble, reasoning);
  }
  if (conv.run?.active) showResumeBar(conv);
}

/* ------------------------------------------------------------- resume bar */
let resumeTimer = null;
function showResumeBar(conv) {
  if (!els.resumeBar) return;
  els.resumeBar.hidden = false;
  $('.resume-text', els.resumeBar).textContent = 'A run was interrupted. Picking up automatically…';
  clearTimeout(resumeTimer);
  resumeTimer = setTimeout(() => resumeRun(conv), 3000);
}
function cancelResume(conv) {
  clearTimeout(resumeTimer);
  els.resumeBar.hidden = true;
  if (conv) { conv.run = null; saveDb(); }
}
function resumeRun(conv) {
  els.resumeBar.hidden = true;
  send('Continue the plan from where it stopped. The Python sandbox was reset by the page refresh, ' +
    'so re-check with list_files before assuming any file still exists, and recreate anything you need.',
    { silent: true });
}

/* ----------------------------------------------------------------- plan view */
function paintPlan(conv) {
  if (!els.planList) return;
  const plan = conv?.plan || [];
  els.planList.innerHTML = '';
  els.planEmpty.hidden = plan.length > 0;
  plan.forEach((s) => {
    const li = document.createElement('li');
    li.setAttribute('data-state', s.state);
    li.textContent = s.text;
    els.planList.appendChild(li);
  });
}

/* ----------------------------------------------------------------- files view
   The sandbox is a single Python VM shared by this browser tab, so its files
   are shared across every conversation — not per-chat. */
async function syncFiles() {
  if (!sandbox.isReady()) return;
  let files = [];
  try { files = await sandbox.listFiles(); } catch { return; }
  const seen = new Set();
  for (const f of files) {
    const name = f.path.replace(`${sandbox.workdir()}/`, '');
    seen.add(name);
    state.files.set(name, { path: f.path, size: `${(f.size / 1024).toFixed(1)} KB` });
  }
  for (const name of [...state.files.keys()]) if (!seen.has(name)) state.files.delete(name);
  paintFiles();
}
function paintFiles() {
  if (!els.fileList) return;
  els.fileList.innerHTML = '';
  els.fileList.appendChild(els.filesEmpty);
  els.filesEmpty.hidden = state.files.size > 0;
  for (const [name, meta] of state.files) {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'file';
    b.setAttribute('aria-current', String(state.openFile === name));
    b.innerHTML = `<span class="ext">${esc((name.split('.').pop() || 'txt').slice(0, 4))}</span>` +
      `<span class="fname">${esc(name)}</span><span class="size">${esc(meta.size)}</span>`;
    b.addEventListener('click', () => openFile(name));
    els.fileList.appendChild(b);
  }
  els.fileCount.textContent = String(state.files.size);
}
async function openFile(name) {
  const meta = state.files.get(name);
  if (!meta) return;
  state.openFile = name; paintFiles();
  els.editorName.textContent = name;
  els.editor.hidden = false;
  try { els.editorArea.value = await sandbox.readFile(meta.path); }
  catch (e) { els.editorArea.value = `(binary or unreadable as text: ${e.message})`; }
}
function download(name, content) {
  const blob = content instanceof Uint8Array ? new Blob([content]) : new Blob([String(content)]);
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

/* ----------------------------------------------------------------- terminal */
function termLine(kind, text) {
  if (!els.term) return;
  for (const line of String(text).split('\n')) {
    const d = document.createElement('div');
    d.className = kind; d.textContent = line;
    els.term.appendChild(d);
  }
  els.termEmpty.hidden = true;
  els.term.parentElement.scrollTop = els.term.parentElement.scrollHeight;
  markPanel('terminal');
}

/* -------------------------------------------------------------- dock helpers */
function openDock(panel) {
  els.app.setAttribute('data-dock', 'open');
  els.dockToggle.setAttribute('aria-pressed', 'true');
  if (panel) selectPanel(panel);
  syncScrim();
}
function selectPanel(panel) {
  $$('.dock-tab').forEach((t) => t.setAttribute('aria-selected', String(t.getAttribute('data-panel') === panel)));
  $$('.dock-panel').forEach((p) => { p.hidden = p.getAttribute('data-panel') !== panel; });
}
function markPanel(panel) { if (window.matchMedia('(min-width: 901px)').matches) openDock(panel); }
function syncScrim() {
  if (!els.scrim) return;
  const open = els.app.getAttribute('data-dock') === 'open' || els.app.getAttribute('data-sidebar') === 'open';
  els.scrim.hidden = !(open && window.matchMedia('(max-width: 900px)').matches);
}
function closeSidebar() { els.app.setAttribute('data-sidebar', 'closed'); syncScrim(); }

function paintAttachments() {
  if (!els.attachRow) return;
  els.attachRow.innerHTML = '';
  els.attachRow.hidden = !state.attachments.size;
  [...state.attachments].forEach((name) => {
    const chip = document.createElement('span');
    chip.className = 'attach';
    chip.innerHTML = `${esc(name)} <button type="button" aria-label="Remove">&times;</button>`;
    $('button', chip).addEventListener('click', () => { state.attachments.delete(name); paintAttachments(); });
    els.attachRow.appendChild(chip);
  });
}

/* ------------------------------------------------------------------ profile */
function paintProfile() {
  const name = db.profile.name || 'You';
  const initial = name[0].toUpperCase();
  if (els.profileName) els.profileName.textContent = db.profile.name || 'Set up profile';
  if (els.profileAvatar) {
    els.profileAvatar.innerHTML = db.profile.avatar
      ? `<img alt="" src="${db.profile.avatar}">` : esc(initial);
  }
}

/* --------------------------------------------------------------------- init */
document.addEventListener('DOMContentLoaded', () => {
  loadDb();
  if (!db.conversations.length) newConversation();
  if (!db.activeId) db.activeId = db.conversations[0].id;

  Object.assign(els, {
    app: $('#app'), thread: $('#thread'), empty: $('#chat-empty'),
    input: $('#composer-input'), form: $('#composer-form'),
    send: $('#send-btn'), stop: $('#stop-btn'), status: $('#status'),
    effortSel: $('#effort-select'),
    upload: $('#upload'), attachRow: $('#attach-row'),
    sheet: $('#settings'), endpoint: $('#set-endpoint'), key: $('#set-key'),
    dockToggle: $('#dock-toggle'), scrim: $('#chat-scrim'),
    sidebarToggle: $('#sidebar-toggle'), sidebarClose: $('#sidebar-close'), convList: $('#conversation-list'),
    term: $('#terminal-out'), termEmpty: $('#terminal-empty'),
    fileList: $('#file-list'), filesEmpty: $('#files-empty'), fileCount: $('#file-count'),
    editor: $('#editor'), editorName: $('#editor-name'), editorArea: $('#editor-area'),
    planList: $('#plan-list'), planEmpty: $('#plan-empty'),
    resumeBar: $('#resume-bar'),
    profileBtn: $('#profile-btn'), profileSheet: $('#profile-sheet'),
    profileName: $('#profile-name'), profileAvatar: $('#profile-avatar'),
    profileNameInput: $('#profile-name-input'), profileAvatarInput: $('#profile-avatar-input'),
    profileAvatarPreview: $('#profile-avatar-preview'), memoryToggle: $('#memory-toggle')
  });

  sandbox.onOutput(({ kind, text }) => termLine(kind, text));

  const autosize = () => {
    els.input.style.height = 'auto';
    els.input.style.height = Math.min(els.input.scrollHeight, 168) + 'px';
  };
  els.input.addEventListener('input', autosize);
  els.input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); }
  });
  els.form.addEventListener('submit', (e) => { e.preventDefault(); submit(); });
  els.stop.addEventListener('click', () => abort?.abort());
  function submit() {
    const text = els.input.value.trim();
    if (!text || running) return;
    els.input.value = ''; els.input.style.height = 'auto';
    send(text);
  }

  els.effortSel.addEventListener('change', () => {
    const conv = activeConv(); if (!conv) return;
    conv.effort = els.effortSel.value; db.effort = conv.effort;
    saveDb();
  });

  $$('[data-prompt]').forEach((b) => b.addEventListener('click', () => {
    send(b.getAttribute('data-prompt'));
  }));

  $('#new-chat').addEventListener('click', () => {
    newConversation();
    renderConversation(); paintConversations();
    closeSidebar();
    els.input.focus();
  });

  /* uploads → stage into the sandbox (zips included; the agent uses zipfile) */
  els.upload.addEventListener('change', async () => {
    for (const file of Array.from(els.upload.files || [])) {
      try {
        const bytes = new Uint8Array(await file.arrayBuffer());
        await sandbox.writeFile(file.name, bytes);
        state.attachments.add(file.name);
      } catch (e) { termLine('err', `upload ${file.name}: ${e.message}`); }
    }
    els.upload.value = '';
    paintAttachments();
    await syncFiles();
    openDock('files');
  });

  /* dock */
  $$('.dock-tab').forEach((t) => t.addEventListener('click', () => selectPanel(t.getAttribute('data-panel'))));
  els.dockToggle.addEventListener('click', () => {
    const open = els.app.getAttribute('data-dock') === 'open';
    els.app.setAttribute('data-dock', open ? 'closed' : 'open');
    els.dockToggle.setAttribute('aria-pressed', String(!open));
    if (!open) els.app.setAttribute('data-sidebar', 'closed');
    syncScrim();
  });
  $('#dock-close').addEventListener('click', () => { els.app.setAttribute('data-dock', 'closed'); syncScrim(); });
  els.sidebarToggle?.addEventListener('click', () => {
    const open = els.app.getAttribute('data-sidebar') === 'open';
    els.app.setAttribute('data-sidebar', open ? 'closed' : 'open');
    if (!open) els.app.setAttribute('data-dock', 'closed');
    syncScrim();
  });
  els.sidebarClose?.addEventListener('click', closeSidebar);
  els.scrim.addEventListener('click', () => {
    els.app.setAttribute('data-dock', 'closed'); closeSidebar();
  });
  window.addEventListener('resize', syncScrim);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { closeSheet(); closeSidebar(); } });

  /* editor */
  $('#editor-save').addEventListener('click', async () => {
    if (!state.openFile) return;
    const meta = state.files.get(state.openFile);
    await sandbox.writeFile(meta.path, els.editorArea.value);
    await syncFiles();
    termLine('ok', `saved ${state.openFile}`);
  });
  $('#editor-download').addEventListener('click', () => { if (state.openFile) download(state.openFile, els.editorArea.value); });
  $('#editor-delete').addEventListener('click', async () => {
    if (!state.openFile) return;
    const meta = state.files.get(state.openFile);
    try { await sandbox.deleteFile(meta.path); } catch { /* gone */ }
    state.files.delete(state.openFile); state.openFile = null;
    els.editor.hidden = true; await syncFiles();
  });

  /* manual terminal */
  $('#terminal-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const line = $('#terminal-input').value.trim();
    if (!line) return;
    $('#terminal-input').value = '';
    try { await sandbox.runCommand(line); } catch (err) { termLine('err', err.message); }
    await syncFiles();
  });

  /* connection settings */
  const openSheet = () => { els.endpoint.value = db.endpoint; els.key.value = db.apiKey; els.sheet.hidden = false; els.endpoint.focus(); };
  function closeSheet() { els.sheet.hidden = true; els.profileSheet.hidden = true; }
  $('#open-settings').addEventListener('click', openSheet);
  $('#cancel-settings').addEventListener('click', closeSheet);
  els.sheet.addEventListener('click', (e) => { if (e.target === els.sheet) closeSheet(); });
  $('#save-settings').addEventListener('click', () => {
    db.endpoint = els.endpoint.value.trim() || DEFAULTS.endpoint;
    db.apiKey = els.key.value.trim();
    saveDb(); closeSheet(); checkHealth();
  });

  /* profile */
  els.profileBtn?.addEventListener('click', () => {
    els.profileNameInput.value = db.profile.name;
    els.profileAvatarPreview.innerHTML = db.profile.avatar ? `<img alt="" src="${db.profile.avatar}">` : 'No photo';
    els.memoryToggle.setAttribute('aria-checked', String(db.memory));
    els.profileSheet.hidden = false;
  });
  $('#cancel-profile').addEventListener('click', closeSheet);
  els.profileSheet?.addEventListener('click', (e) => { if (e.target === els.profileSheet) closeSheet(); });
  els.profileAvatarInput?.addEventListener('change', () => {
    const file = els.profileAvatarInput.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => { els.profileAvatarPreview.innerHTML = `<img alt="" src="${reader.result}">`; els.profileAvatarPreview.dataset.pending = reader.result; };
    reader.readAsDataURL(file);
  });
  els.memoryToggle?.addEventListener('click', () => {
    const on = els.memoryToggle.getAttribute('aria-checked') === 'true';
    els.memoryToggle.setAttribute('aria-checked', String(!on));
  });
  $('#save-profile').addEventListener('click', () => {
    db.profile.name = els.profileNameInput.value.trim();
    if (els.profileAvatarPreview.dataset.pending) db.profile.avatar = els.profileAvatarPreview.dataset.pending;
    db.memory = els.memoryToggle.getAttribute('aria-checked') === 'true';
    saveDb(); paintProfile(); closeSheet();
  });
  $('#remove-avatar').addEventListener('click', () => {
    db.profile.avatar = ''; delete els.profileAvatarPreview.dataset.pending;
    els.profileAvatarPreview.innerHTML = 'No photo';
  });

  /* resume */
  $('#resume-cancel')?.addEventListener('click', () => cancelResume(activeConv()));
  $('#resume-now')?.addEventListener('click', () => { clearTimeout(resumeTimer); resumeRun(activeConv()); });

  paintProfile();
  renderConversation();
  paintConversations();
  checkHealth();
  els.input.focus();
});
