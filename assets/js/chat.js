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

/* -------------------------------------------------------------- providers
   Bring-your-own-key model backends. Every request goes straight from this
   browser to the provider — no CorX server in the middle — so a provider
   only works here if it actually allows cross-origin browser calls.

   browser: true  = documented to allow direct browser calls (CORS open, or
                    Anthropic's explicit opt-in header). Reliable here.
            false = the provider blocks browser calls; it needs a proxy, so
                    it will hit a CORS wall. Kept in the list, but honestly
                    flagged, because people ask for it.

   kind:  'openai'    — OpenAI-compatible /v1/chat/completions + SSE.
          'anthropic' — Anthropic /v1/messages (system split out, different
                        SSE event shape).
   Keys are stored per-provider in db.keys and never leave the browser
   except to that provider's own API. */
const PROVIDERS = {
  corx: {
    label: 'CorX3.8', kind: 'openai', tint: '#b06a3b', browser: true, keyless: true, domain: 'corx-labs.com',
    hint: "Your own self-hosted CorX3.8-27B. Keyless by default — just paste the tunnel URL.",
    models: ['corx3.8'],
    mark: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M18 7.5a7 7 0 1 0 0 9"/></svg>'
  },
  openrouter: {
    label: 'OpenRouter', kind: 'openai', base: 'https://openrouter.ai/api', tint: '#6f7bf7', browser: true, domain: 'openrouter.ai',
    keyUrl: 'https://openrouter.ai/keys',
    hint: 'One key, hundreds of models (Claude, GPT, Llama, DeepSeek…). Works straight from the browser. Recommended if you want a paid model.',
    models: ['deepseek/deepseek-chat', 'anthropic/claude-3.5-sonnet', 'openai/gpt-4o-mini', 'google/gemini-flash-1.5', 'meta-llama/llama-3.3-70b-instruct', 'qwen/qwen-2.5-72b-instruct'],
    mark: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="5" cy="7" r="1.6" fill="currentColor" stroke="none"/><circle cx="5" cy="17" r="1.6" fill="currentColor" stroke="none"/><path d="M6.6 7h5.4l4 5h3"/><path d="M6.6 17h5.4l2-2.5"/><path d="M16.5 8.5 20 12l-3.5 3.5"/></svg>'
  },
  anthropic: {
    label: 'Claude', kind: 'anthropic', base: 'https://api.anthropic.com', tint: '#d4915d', browser: true, domain: 'claude.ai',
    keyUrl: 'https://console.anthropic.com/settings/keys',
    hint: "Anthropic's Claude, called directly with the browser-access header. Needs an Anthropic API key.",
    models: ['claude-3-5-sonnet-latest', 'claude-3-5-haiku-latest', 'claude-3-opus-latest'],
    mark: '<svg viewBox="0 0 24 24" fill="currentColor" stroke="none" aria-hidden="true"><path d="M17.3041 3.541h-3.6718l6.696 16.918H24ZM6.6959 3.541 0 20.459h3.7442l1.3693-3.5527h7.0052l1.3693 3.5528h3.7442L10.5363 3.541Zm-.3712 10.2231 2.2914-5.9456 2.2914 5.9456Z"/></svg>'
  },
  deepseek: {
    label: 'DeepSeek', kind: 'openai', base: 'https://api.deepseek.com', tint: '#4d6bfe', browser: false, domain: 'deepseek.com',
    keyUrl: 'https://platform.deepseek.com/api_keys',
    hint: 'DeepSeek direct. Cheap and strong, but DeepSeek may block browser calls — if it fails with a CORS error, route it through OpenRouter instead.',
    models: ['deepseek-chat', 'deepseek-reasoner'],
    mark: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 14c3 3 13 3 16-2-2 1-4 .5-5-1 3-1 4-4 3-7-1 2-3 3-5 3-4 0-8 3-9 7z"/></svg>'
  },
  openai: {
    label: 'OpenAI', kind: 'openai', base: 'https://api.openai.com', tint: '#10a37f', browser: false, domain: 'openai.com',
    keyUrl: 'https://platform.openai.com/api-keys',
    hint: 'ChatGPT models direct. OpenAI blocks browser calls, so this usually fails with a CORS error unless you proxy it — OpenRouter is the browser-friendly way to reach GPT models.',
    models: ['gpt-4o-mini', 'gpt-4o', 'o4-mini'],
    mark: '<svg viewBox="0 0 24 24" fill="currentColor" stroke="none" aria-hidden="true"><path d="M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.1419.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z"/></svg>'
  }
};
const providerOf = () => PROVIDERS[db.provider] || PROVIDERS.corx;

/* Each provider's real logo, taken from its own site favicon (the same
   service already used for search-result icons), with the inline SVG mark
   kept as the fallback if the image can't load — offline, blocked, or the
   host has no icon. That way the picker shows genuine brand marks rather
   than approximations, and still renders something sensible when it can't
   reach the network. */
function providerMark(p) {
  if (!p.domain) return p.mark;
  // The fallback is wired by wireBrandFallbacks() rather than an inline
  // onerror attribute, which the site's CSP (script-src 'self') blocks.
  return `<img class="brand-img" alt="" width="18" height="18" loading="lazy"` +
    ` data-fallback="${esc(p.label)}"` +
    ` src="https://icons.duckduckgo.com/ip3/${encodeURIComponent(p.domain)}.ico">`;
}
/* Swap any brand image that fails to load for that provider's inline mark. */
function wireBrandFallbacks(root) {
  for (const img of $$('img.brand-img', root)) {
    if (img.dataset.wired) continue;
    img.dataset.wired = '1';
    img.addEventListener('error', () => {
      const p = Object.values(PROVIDERS).find((x) => x.label === img.dataset.fallback);
      const span = document.createElement('span');
      span.innerHTML = p ? p.mark : '';
      img.replaceWith(...span.childNodes);
    }, { once: true });
  }
}
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
/* Catches the model claiming it has no internet/real-time access instead of
   calling web_search, which it always has — a known failure mode with no
   native tool-calling to fall back on. Used to auto-correct once per
   message rather than silently accepting the wrong answer. */
const TOOL_REFUSAL_RE = /\b(don'?t|do ?not|cannot|can'?t|cyaan|cyah|nuh) (have |gi |get )?access( to)? (real-?time|the internet|di internet|current|live|today'?s|up-?to-?date)|training data (has|only|is limited|goes up)|(as of|since) my (last|training) (update|cutoff|knowledge)|no real-?time (news|access|data|information)|(can'?t|cannot|cyaan) browse (the|di) internet|(don'?t|do not|nuh) have (real-?time|internet) (access|data)/i;

const EFFORT = {
  low:    { label: 'Low',    maxTokens: 512,  temperature: 0.7,  rounds: 3,  searchN: 3,
            hint: 'Keep your reasoning short. Answer directly.' },
  medium: { label: 'Medium', maxTokens: 1024, temperature: 0.7,  rounds: 5,  searchN: 4,
            hint: 'Think briefly in a <think> block first if the question needs it.' },
  high:   { label: 'High',   maxTokens: 2048, temperature: 0.65, rounds: 8,  searchN: 6,
            hint: 'Think step by step in a <think> block before answering. Break the problem into parts. If you write code, glance back over it once for obvious mistakes before you run it.' },
  extra:  { label: 'Extra',  maxTokens: 4096, temperature: 0.6,  rounds: 14, searchN: 8,
            hint: 'Think carefully and step by step in a <think> block. Consider more than one approach, check your own reasoning for mistakes, and search when you are not sure of something. After you write code or a solution, spend a second <think> pass reviewing what you just made specifically for bugs or missed cases before presenting it as done — do not treat the first draft as the final one.' },
  max:    { label: 'Max',    maxTokens: 6144, temperature: 0.55, rounds: 24, searchN: 10,
            hint: 'This is the highest effort level — spend real tokens on it, a shallow first pass is not acceptable here. Think exhaustively in a <think> block: break the problem into parts, weigh more than one approach, verify each step, search liberally for anything you are not fully sure of. Once you produce code or a solution, stop and deliberately review it in a fresh <think> block as if it were someone else\'s work you were asked to critique — look specifically for bugs, wrong assumptions, missed edge cases and unnecessary steps — then revise or redo whatever you find wrong before answering, and repeat that check again if you changed anything. If partway through you realise something you already told the user was wrong, stop and correct it plainly rather than quietly continuing. Use as many tool calls and rounds as the task genuinely needs.' }
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
    provider: 'corx',
    keys: {},               // per-provider API keys, e.g. { openrouter: 'sk-...' }
    modelByProvider: {},    // remembers the last model chosen for each provider
    github: { token: '', repo: '', branch: '' },  // PAT + active repo, browser-only
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

/* Base URL for the active provider: CorX uses the user's own tunnel URL;
   the hosted providers use their fixed API root. */
function providerBase() {
  const p = providerOf();
  if (db.provider === 'corx') return base();
  // Normalise: no trailing slash and no trailing /v1 — the request builder
  // always appends /v1/..., so a base given either way can't double up.
  return (p.base || '').replace(/\/+$/, '').replace(/\/v1$/, '');
}
function activeKey() { return db.provider === 'corx' ? db.apiKey : (db.keys[db.provider] || ''); }
function activeModel() {
  const p = providerOf();
  return db.modelByProvider[db.provider] || db.model || p.models[0];
}

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

/* ------------------------------------------------------------------ memory
   Cross-chat memory. search_memory lets the model go looking on purpose, but
   that only helps if it thinks to ask. This builds a short standing digest of
   the user's OTHER conversations — what they were about and the last thing
   said in each — and injects it into every system prompt, so context carries
   between chats without the model having to request it. Kept small on
   purpose: a digest, not a transcript, so it can't crowd out the real
   conversation. */
function memoryDigest(conv) {
  if (!db.memory) return '';
  const others = db.conversations
    .filter((c) => c.id !== conv.id && c.messages.some((m) => !m.synthetic))
    .slice(0, 8);
  if (!others.length) return '';
  const lines = others.map((c) => {
    const real = c.messages.filter((m) => !m.synthetic && m.role !== 'system');
    const firstUser = real.find((m) => m.role === 'user');
    const last = real[real.length - 1];
    const when = c.updated ? new Date(c.updated).toISOString().slice(0, 10) : '';
    const gist = (t) => String(t || '').replace(/<think>[\s\S]*?<\/think>/gi, ' ')
      .replace(/<tool>[\s\S]*?<\/tool>/gi, ' ').replace(/\s+/g, ' ').trim().slice(0, 160);
    return `- "${c.title}"${when ? ` (${when})` : ''}: asked — ${gist(firstUser?.content)}` +
      (last && last !== firstUser ? ` | last — ${gist(last.content)}` : '');
  });
  return `\n\nMEMORY — the user's other saved chats in this browser (context carried over; do not bring these up unless relevant):\n${lines.join('\n')}\nUse search_memory to pull the full text of any of these when you need detail.`;
}

/* -------------------------------------------------------------- system prompt */
function buildSystem(conv) {
  const eff = EFFORT[conv.effort] || EFFORT.medium;
  const name = db.profile.name ? ` The user's name is ${db.profile.name}.` : '';
  const base = `You are Corx, a helpful Jamaican AI assistant made by CorX Labs. You speak Jamaican Patois by default and switch to standard English when the user writes in English or asks you to. Be direct: give your actual answer plainly, without softening it, hedging it into mush, or being flippant about it. If the user says or assumes something wrong, tell them plainly that they are wrong and why — do not just agree to be agreeable. Know what is actually achievable and say so: do not promise something is done, fixed, or possible when it is not, and do not pretend a failed attempt worked.${name}\n\n${eff.hint}`;

  // GitHub tools are offered only when the user has connected a token.
  const githubTools = db.github.token ? `
GitHub is connected${db.github.repo ? ` — active repo ${db.github.repo}${db.github.branch ? ` on ${db.github.branch}` : ''}` : ''}. Before any change: github_tree to see the repo, github_read_file on what you'll touch, then write. repo/branch default to the active one.
- github_list_repos {} / github_tree {} / github_read_file {"path"} — read the project.
- github_write_file {"path","content","message"} — create or update a file; each call is a real commit (the push). Read the file first.
- github_delete_file {"path","message"} — delete (a commit).
- github_create_repo {"name","private":true} — new repo, becomes active.
- github_pull_request {"title","head","base","body","merge":false} — open a PR; "merge":true merges it.` : '';

  return `${base}${memoryDigest(conv)}

You have a real Python sandbox and real internet access. Use them without asking. Call a tool by writing this on its own line, valid JSON, one per line:
<tool>{"name": "TOOL_NAME", "arguments": { ... }}</tool>
Example: <tool>{"name": "write_file", "arguments": {"path": "hello.py", "content": "print('hello')"}}</tool>
Several calls per reply is fine; you'll be shown the results and can continue. Finish by replying with no tool line.

COMMANDS YOU CAN RUN RIGHT NOW — your full toolset, from the first message of every conversation. Never claim you lack one:
- set_plan {"steps": [...]} / complete_step {"index": 0} — publish and tick a checklist for any job over two steps.
- run_python {"code": "..."} — run Python; state persists; you get what it printed. For HTTP inside the sandbox use "import web" then web.get(url)/web.post(url, body) — requests/urllib do NOT work. Zips: zipfile.ZipFile('/work/x.zip'); write with mode 'w'/'a' and .writestr(name, data).
- write_file {"path","content"} / read_file {"path"} / delete_file {"path"} / list_files {} — files in /work.
- install_packages {"packages": ["numpy"]} — micropip.
- deliver_file {"path"} — hand the user a download.
- web_search {"query": "...", "n": ${eff.searchN}} — real search. Call it for ANY question asking for information (facts, people, places, definitions, how things work, comparisons), not just current events — your training data may be stale. Skip it only for small talk, things already said in this chat, pure code/math, or explaining something just shown to you.
- fetch_url {"url"} — read a page's real content, including code on it. Use after web_search on the best result.
- search_memory {"query"} — search the user's other saved chats for detail.
${githubTools}
Rules:
- Never say you can't do something a tool covers — call the tool.
- Asked to write/build/create code? Call write_file and run_python for real. A markdown block alone is not acceptable; create it, run it, show it working, then show the code.
- Never ship code you haven't run. Build in pieces: write a piece, run it, read the output, fix and re-run until it works. Check it in your <think> block before running. If run_python errors, read the traceback and fix it yourself next call. If you truly can't get it working, say so plainly — never claim it works when it doesn't.
- Asked what you can do? Answer from the list above by name; no tool call needed.
- Read what the user meant, not what they typed — silently correct typos instead of getting stuck.
- Reading more than one source when they might disagree; say so plainly if they conflict.
- Final code/output goes in normal markdown after the tools that made it real. Keep the Patois voice; tool lines stay exact JSON.`;
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
   what the user sees. A reply can contain more than one <think> block (a
   model that pauses to re-plan mid-answer, or a still-streaming block with
   no closing tag yet) — all of them are pulled into one grey dropdown, not
   just the first, so nothing leaks into the visible answer unseparated. */
function splitThinking(text) {
  const source = String(text);
  const closed = [...source.matchAll(/<think>([\s\S]*?)<\/think>/gi)].map((m) => m[1].trim());
  let rest = source.replace(/<think>[\s\S]*?<\/think>/gi, '');
  const open = rest.match(/<think>([\s\S]*)$/i);
  if (open) { closed.push(open[1].trim()); rest = rest.slice(0, open.index); }
  const reasoning = closed.filter(Boolean).join('\n\n');
  const answer = rest.replace(/<tool>[\s\S]*?<\/tool>/gi, '').replace(/```tool\s*[\s\S]*?```/gi, '').trim();
  return { reasoning, answer };
}

/* Pull tool calls out of a completed assistant message. */
function parseToolCalls(text) {
  const calls = [];
  const push = (raw) => {
    try {
      const obj = JSON.parse(raw.trim());
      // Normalise the name (trim, lowercase, spaces/dashes to underscores) so a
      // model that writes "Run_Python" or "run-python" still resolves to the
      // real run_python tool instead of silently hitting "Unknown tool".
      if (obj && typeof obj.name === 'string') {
        const name = obj.name.trim().toLowerCase().replace(/[\s-]+/g, '_');
        calls.push({ name, args: obj.arguments || obj.args || {} });
      }
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

/* ------------------------------------------------------------------ github
   The user's GitHub Personal Access Token lives only in this browser and is
   sent only to api.github.com (which allows cross-origin browser calls). The
   agent gets a small set of tools built on top of the REST API: list repos,
   read a repo's tree and files, write/delete files (each write is a commit —
   that IS the "push"), create a repo, and open/merge a pull request. */
const b64encodeUtf8 = (s) => btoa(String.fromCharCode(...new TextEncoder().encode(s)));
function b64decodeUtf8(b64) {
  const bin = atob(String(b64).replace(/\n/g, ''));
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}
async function gh(method, path, body) {
  const token = db.github.token;
  if (!token) throw new Error('No GitHub token set. Open the GitHub panel and paste a token.');
  const res = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      ...(body ? { 'content-type': 'application/json' } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  let data; try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (!res.ok) {
    throw new Error(`GitHub ${res.status}: ${data.message || text.slice(0, 200)}`);
  }
  return data;
}
/* List the user's repositories.

   Fine-grained tokens (github_pat_…) behave differently from classic ones:
   passing `affiliation` can come back with an empty list even though the
   token has access, and a token scoped to selected repositories only shows
   those. So try the plain listing first, then fall back to the user's own
   public listing, then to the GitHub App installation listing. Returns the
   identity too, so the panel can say who it authenticated as. */
async function ghListRepos() {
  const me = await gh('GET', '/user').catch(() => ({}));
  const tries = [
    '/user/repos?per_page=100&sort=updated',
    me.login ? `/users/${encodeURIComponent(me.login)}/repos?per_page=100&sort=updated` : null
  ].filter(Boolean);

  for (const path of tries) {
    try {
      const list = await gh('GET', path);
      if (Array.isArray(list) && list.length) return { me, repos: list };
    } catch { /* try the next strategy */ }
  }
  // GitHub App installation tokens expose repos under a different route.
  try {
    const inst = await gh('GET', '/installation/repositories?per_page=100');
    if (inst.repositories?.length) return { me, repos: inst.repositories };
  } catch { /* not an installation token */ }
  return { me, repos: [] };
}

/* Resolve owner/repo + branch, defaulting to the selected repo. */
function ghRepo(arg) {
  const full = (arg || db.github.repo || '').trim();
  const [owner, repo] = full.split('/');
  if (!owner || !repo) throw new Error('No repository chosen. Pick one in the GitHub panel, or pass "repo": "owner/name".');
  return { owner, repo, full };
}
async function ghDefaultBranch(owner, repo) {
  const info = await gh('GET', `/repos/${owner}/${repo}`);
  return info.default_branch || 'main';
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
  web_search: 'Searching the web', fetch_url: 'Reading a page', search_memory: 'Recalling memory',
  github_list_repos: 'GitHub · repos', github_tree: 'GitHub · files', github_read_file: 'GitHub · read',
  github_write_file: 'GitHub · commit', github_delete_file: 'GitHub · delete',
  github_create_repo: 'GitHub · new repo', github_pull_request: 'GitHub · pull request'
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
/* A file the agent just created (write_file) or handed over (deliver_file),
   shown as its own clickable card instead of buried in a plain-text tool
   card — click the name to preview it in the Files panel (a .zip lists its
   contents instead of showing raw bytes), or the download icon to save it
   straight away without opening anything. */
function addFileCard(path) {
  if (!currentTools || !path) return;
  const name = String(path).split('/').pop();
  const card = document.createElement('div');
  card.className = 'file-card';
  card.innerHTML =
    '<button type="button" class="file-card-open">' +
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 3v5h5"/><path d="M6 3h8l5 5v13a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z"/></svg>' +
    `<span class="fname">${esc(name)}</span><span class="fhint">Click to view</span>` +
    '</button>' +
    `<button type="button" class="file-card-dl" title="Download ${esc(name)}" aria-label="Download ${esc(name)}">` +
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 4v11M7 10l5 5 5-5"/><path d="M5 19h14"/></svg></button>';
  $('.file-card-open', card).addEventListener('click', async () => {
    await syncFiles();
    openDock('files');
    await openFile(name);
  });
  $('.file-card-dl', card).addEventListener('click', async (e) => {
    e.stopPropagation();
    try {
      await syncFiles();
      const meta = state.files.get(name);
      const bytes = await sandbox.readFile(meta ? meta.path : `${sandbox.workdir()}/${name}`, true);
      download(name, bytes);
    } catch (err) { termLine('err', `download ${name}: ${err.message}`); }
  });
  currentTools.appendChild(card);
  scrollDown();
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

/* search: one widget from "searching" to the URL list.
   renderSearch() opens it immediately with a placeholder slide of generic
   favicons — the real sites aren't known yet, there's nothing else honest
   to show while the request is still in flight. finishSearch() closes it
   into a normal clickable summary once the results are back, and swaps
   that placeholder row for the sliding favicons of the actual sites found
   (still animating, just no longer generic) — or drops the row entirely on
   a failure, since there's nothing real to show. The widget itself is
   never removed, so it stays clickable (live or after a refresh) to reveal
   the real URLs, or the failure reason. */
const SEARCH_DOMAINS = ['wikipedia.org', 'github.com', 'nature.com', 'reuters.com', 'arxiv.org', 'bbc.com'];
function sourceRowHtml(r) {
  return `<a class="source-row" href="${esc(r.url)}" target="_blank" rel="noopener nofollow">` +
    `<img class="favicon" alt="" width="16" height="16" loading="lazy" src="https://icons.duckduckgo.com/ip3/${encodeURIComponent(r.domain)}.ico">` +
    `<span class="src-text"><strong>${esc(r.title)}</strong><small>${esc(r.domain)}</small>` +
    `${r.snippet ? `<small class="snippet">${esc(r.snippet)}</small>` : ''}</span></a>`;
}
function renderSearch(query) {
  if (!currentTools) return null;
  const box = document.createElement('details');
  box.className = 'search-strip';
  box.open = true;
  box.innerHTML = '<summary>' +
    `<span class="label">Searching &ldquo;${esc(String(query).slice(0, 44))}&rdquo;</span>` +
    `<span class="track-wrap"><span class="track">${SEARCH_DOMAINS.concat(SEARCH_DOMAINS).map((d) =>
      `<img class="favicon" alt="" src="https://icons.duckduckgo.com/ip3/${d}.ico">`).join('')}</span></span>` +
    '<span class="chev" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg></span>' +
    '</summary><div class="search-body"></div>';
  currentTools.appendChild(box);
  scrollDown();
  return box;
}
function finishSearch(box, { query, results, error }) {
  if (!box) return;
  box.open = false;
  const label = $('.label', box);
  const body = $('.search-body', box);
  const trackWrap = $('.track-wrap', box);
  if (results && results.length) {
    label.textContent = `Searched the web · ${results.length} source${results.length === 1 ? '' : 's'}`;
    body.innerHTML = results.map(sourceRowHtml).join('');
    // Swap the generic placeholder icons (shown while the query was still
    // in flight, before any real site was known) for the actual sites just
    // found — a fresh element, so the slide keeps animating with the
    // genuine favicons instead of stock ones.
    const domains = [...new Set(results.map((r) => r.domain).filter(Boolean))];
    if (domains.length && trackWrap) {
      const loop = domains.length > 1 ? domains.concat(domains) : Array(6).fill(domains[0]);
      trackWrap.innerHTML = `<span class="track">${loop.map((d) =>
        `<img class="favicon" alt="" src="https://icons.duckduckgo.com/ip3/${encodeURIComponent(d)}.ico">`).join('')}</span>`;
    }
  } else {
    label.textContent = 'Search failed — click for details';
    body.innerHTML = `<p class="search-error">&ldquo;${esc(query || '')}&rdquo; &mdash; ${esc(error || 'no results')}</p>`;
    if (trackWrap) trackWrap.remove();
  }
}

/* ------------------------------------------------------------------ health
   Only CorX3.8's self-hosted server exposes a /health endpoint we can ping
   (and that we're allowed to hit cross-origin). Hosted providers don't, and
   a preflight there would just fail CORS — so for those we show readiness
   from whether a key is present rather than pinging. */
async function checkHealth() {
  const p = providerOf();
  if (db.provider !== 'corx') {
    if (!activeKey()) setStatus('down', `${p.label} · add key`);
    else setStatus('ok', p.label);
    return;
  }
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

/* Header pill: the active provider's mark + the active model name. */
function paintModelLabel() {
  if (!els.msName) return;
  const p = providerOf();
  const model = activeModel();
  // Show a short model name — drop the "vendor/" prefix OpenRouter uses.
  const shortModel = String(model).split('/').pop();
  els.msMark.innerHTML = providerMark(p);
  wireBrandFallbacks(els.msMark);
  els.msMark.style.setProperty('--tint', p.tint);
  els.msName.textContent = db.provider === 'corx' ? 'CorX3.8' : shortModel;
  els.modelSwitch.title = `${p.label} · ${model} — click to switch`;
}

/* GitHub button reflects whether a token is connected and which repo is active. */
function paintGithub() {
  if (!els.githubBtn) return;
  const on = !!db.github.token;
  els.githubBtn.classList.toggle('is-on', on);
  els.githubBtn.title = on
    ? `GitHub connected${db.github.repo ? ` · ${db.github.repo}` : ' · pick a repo'}`
    : 'Connect GitHub — read repos, commit, push, PRs';
  if (els.ghActive) {
    els.ghActive.hidden = !db.github.repo;
    els.ghActive.textContent = db.github.repo ? `Active: ${db.github.repo}` : '';
  }
}

/* ------------------------------------------------------------- tool runners
   `meta` is an out-param: tools that produce something richer than a text
   blob (currently just web_search's result list) drop it there so the
   caller can persist it on the message and reconstruct the same sources
   dropdown after a reload, instead of only keeping the flattened text the
   model sees. */
async function execTool(name, args, conv, meta = {}) {
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
      const box = renderSearch(q);
      termLine('cmd', `search "${q}" (${n})`);
      let data;
      try {
        const res = await fetch(`/api/search?q=${encodeURIComponent(q)}&n=${n}`);
        data = await res.json();
      } catch (e) { data = { error: e.message, results: [] }; }
      const results = data.results || [];
      meta.results = results;
      finishSearch(box, { query: q, results, error: data.error });
      if (!results.length) { termLine('err', data.error || 'no results'); return `No results${data.error ? ` (${data.error})` : ''}.`; }
      termLine('ok', `${results.length} results`);
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

    /* ---- GitHub tools ---- */
    case 'github_list_repos': {
      termLine('cmd', 'gh: list repos');
      const { me, repos } = await ghListRepos();
      termLine('ok', `${repos.length} repos`);
      if (!repos.length) {
        return `No repositories visible to this token (authenticated as ${me.login || 'unknown'}). ` +
          'If it is a fine-grained token, its "Repository access" must list the repos, and it needs Contents: read & write.';
      }
      return repos.map((r) => `${r.full_name}${r.private ? ' (private)' : ''} — default: ${r.default_branch}${r.description ? ` — ${r.description}` : ''}`).join('\n');
    }
    case 'github_tree': {
      const { owner, repo, full } = ghRepo(args.repo);
      const branch = args.branch || (full === db.github.repo && db.github.branch) || await ghDefaultBranch(owner, repo);
      termLine('cmd', `gh: tree ${owner}/${repo}@${branch}`);
      const t = await gh('GET', `/repos/${owner}/${repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`);
      const files = (t.tree || []).filter((n) => n.type === 'blob').map((n) => n.path);
      termLine('ok', `${files.length} files`);
      return files.length ? files.join('\n') : '(empty repo)';
    }
    case 'github_read_file': {
      const { owner, repo, full } = ghRepo(args.repo);
      const branch = args.branch || (full === db.github.repo && db.github.branch) || '';
      const q = branch ? `?ref=${encodeURIComponent(branch)}` : '';
      termLine('cmd', `gh: read ${owner}/${repo}/${args.path}`);
      const f = await gh('GET', `/repos/${owner}/${repo}/contents/${encodeURI(args.path)}${q}`);
      if (Array.isArray(f)) return f.map((e) => `${e.type}: ${e.path}`).join('\n');  // it's a directory
      const content = f.content ? b64decodeUtf8(f.content) : '';
      termLine('ok', `${content.length} chars`);
      return content || '(empty file)';
    }
    case 'github_write_file': {
      const { owner, repo, full } = ghRepo(args.repo);
      const branch = args.branch || (full === db.github.repo && db.github.branch) || await ghDefaultBranch(owner, repo);
      const path = String(args.path || '').replace(/^\/+/, '');
      if (!path) throw new Error('github_write_file needs a path.');
      // Look up the existing file's sha (required to update; omitted to create).
      let sha;
      try { const cur = await gh('GET', `/repos/${owner}/${repo}/contents/${encodeURI(path)}?ref=${encodeURIComponent(branch)}`); sha = cur.sha; } catch { /* new file */ }
      termLine('cmd', `gh: ${sha ? 'update' : 'create'} ${owner}/${repo}/${path}`);
      const r = await gh('PUT', `/repos/${owner}/${repo}/contents/${encodeURI(path)}`, {
        message: args.message || `${sha ? 'Update' : 'Create'} ${path}`,
        content: b64encodeUtf8(args.content ?? ''),
        branch, ...(sha ? { sha } : {})
      });
      termLine('ok', `commit ${r.commit?.sha?.slice(0, 7) || ''}`);
      return `${sha ? 'Updated' : 'Created'} ${path} on ${branch} — commit ${r.commit?.sha?.slice(0, 7)}. ${r.content?.html_url || ''}`;
    }
    case 'github_delete_file': {
      const { owner, repo, full } = ghRepo(args.repo);
      const branch = args.branch || (full === db.github.repo && db.github.branch) || await ghDefaultBranch(owner, repo);
      const path = String(args.path || '').replace(/^\/+/, '');
      const cur = await gh('GET', `/repos/${owner}/${repo}/contents/${encodeURI(path)}?ref=${encodeURIComponent(branch)}`);
      termLine('cmd', `gh: delete ${owner}/${repo}/${path}`);
      const r = await gh('DELETE', `/repos/${owner}/${repo}/contents/${encodeURI(path)}`, {
        message: args.message || `Delete ${path}`, sha: cur.sha, branch
      });
      termLine('ok', `commit ${r.commit?.sha?.slice(0, 7) || ''}`);
      return `Deleted ${path} on ${branch} — commit ${r.commit?.sha?.slice(0, 7)}.`;
    }
    case 'github_create_repo': {
      const name = String(args.name || '').trim();
      if (!name) throw new Error('github_create_repo needs a name.');
      termLine('cmd', `gh: create repo ${name}`);
      const r = await gh('POST', '/user/repos', {
        name, private: args.private !== false, auto_init: args.auto_init !== false,
        description: args.description || ''
      });
      // Auto-select the new repo so follow-up file tools target it.
      db.github.repo = r.full_name; db.github.branch = r.default_branch || 'main'; saveDb(); paintGithub();
      termLine('ok', r.full_name);
      return `Created ${r.full_name} (${r.private ? 'private' : 'public'}) and selected it. ${r.html_url}`;
    }
    case 'github_pull_request': {
      const { owner, repo } = ghRepo(args.repo);
      termLine('cmd', `gh: PR ${args.head} → ${args.base}`);
      const pr = await gh('POST', `/repos/${owner}/${repo}/pulls`, {
        title: args.title || `Update from CorX`, head: args.head, base: args.base || await ghDefaultBranch(owner, repo),
        body: args.body || ''
      });
      let note = `Opened PR #${pr.number}: ${pr.html_url}`;
      if (args.merge) {
        const m = await gh('PUT', `/repos/${owner}/${repo}/pulls/${pr.number}/merge`, { merge_method: args.merge_method || 'merge' });
        note += m.merged ? ` — merged (${m.sha?.slice(0, 7)}).` : ` — merge not completed: ${m.message || ''}`;
      }
      termLine('ok', `PR #${pr.number}`);
      return note;
    }

    default:
      return `Unknown tool: ${name}`;
  }
}

/* Build the HTTP request for whichever provider is active. OpenAI-compatible
   backends (CorX, OpenRouter, DeepSeek, OpenAI) share one shape; Anthropic's
   Messages API takes the system prompt as a separate field and needs its own
   headers, so it gets its own branch. */
function buildRequest(conv) {
  const p = providerOf();
  const eff = EFFORT[conv.effort] || EFFORT.medium;
  const key = activeKey();
  const model = activeModel();
  const sys = buildSystem(conv);
  const turns = conv.messages.map((m) => ({ role: m.role, content: m.content }));

  if (p.kind === 'anthropic') {
    // Anthropic requires strictly alternating user/assistant turns — coalesce
    // any accidental same-role run (e.g. two synthetic user messages) so a
    // long agent loop can't trip its validation.
    const msgs = [];
    for (const t of turns) {
      const last = msgs[msgs.length - 1];
      if (last && last.role === t.role) last.content += `\n\n${t.content}`;
      else msgs.push({ role: t.role, content: t.content });
    }
    return {
      url: `${providerBase()}/v1/messages`,
      headers: {
        'content-type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true'
      },
      body: { model, system: sys, messages: msgs, stream: true,
        max_tokens: eff.maxTokens, temperature: eff.temperature },
      kind: 'anthropic'
    };
  }

  const headers = { 'content-type': 'application/json' };
  if (key) headers.authorization = `Bearer ${key}`;
  // OpenRouter likes an attribution header; harmless to others.
  if (db.provider === 'openrouter') { headers['HTTP-Referer'] = 'https://corx-labs.com/chat/'; headers['X-Title'] = 'CorX Chat'; }
  return {
    url: `${providerBase()}/v1/chat/completions`,
    headers,
    body: { model, messages: [{ role: 'system', content: sys }, ...turns], stream: true,
      max_tokens: eff.maxTokens, temperature: eff.temperature },
    kind: 'openai'
  };
}

/* -------------------------------------------------------------- one API call */
async function streamOnce(conv, bubble) {
  abort = new AbortController();
  const req = buildRequest(conv);

  let res;
  try {
    res = await fetch(req.url, {
      method: 'POST', signal: abort.signal, headers: req.headers,
      body: JSON.stringify(req.body)
    });
  } catch (e) {
    // A blocked cross-origin call throws a TypeError here rather than
    // returning a status, so name the likely cause honestly.
    if (e.name === 'AbortError') throw e;
    const p = providerOf();
    throw new Error(`Couldn't reach ${p.label}. ${p.browser === false
      ? `${p.label} blocks direct browser calls — try OpenRouter instead.`
      : 'Check the endpoint/key and that the server is up.'} (${e.message})`);
  }

  if (!res.ok) {
    let detail = '';
    try { const j = await res.json(); detail = j.detail || j.error?.message || (typeof j.error === 'string' ? j.error : ''); }
    catch { detail = await res.text().catch(() => ''); }
    throw new Error(`${providerOf().label} returned ${res.status}${detail ? ` — ${String(detail).slice(0, 200)}` : ''}`);
  }
  if (!res.body) throw new Error('No response stream.');

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '', acc = '';
  const startedAt = Date.now();
  const paint = () => {
    const { reasoning, answer } = splitThinking(acc);
    if (reasoning) paintReasoning(bubble, reasoning);
    bubble.innerHTML = answer ? renderMarkdown(answer)
      : '<p class="typing"><span></span><span></span><span></span></p>';
    scrollDown();
  };
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
        // OpenAI: choices[].delta.content. Anthropic: content_block_delta → delta.text.
        const delta = req.kind === 'anthropic'
          ? (evt?.type === 'content_block_delta' ? evt?.delta?.text : '')
          : evt?.choices?.[0]?.delta?.content;
        if (delta) { acc += delta; paint(); }
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
  let nudgedTools = false;

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

      const assistantMsg = { role: 'assistant', content: reply };
      conv.messages.push(assistantMsg);
      if (!calls.length) {
        // The model has no native tool-calling, so nothing forces it to
        // actually call web_search when it should — it can just say "I
        // don't have internet access" in plain prose instead, even though
        // the tool is right there. Catch that specific failure once per
        // message and push it back with a direct correction instead of
        // quietly accepting a wrong answer.
        if (!nudgedTools && round < eff.rounds - 1 && TOOL_REFUSAL_RE.test(answer)) {
          nudgedTools = true;
          conv.messages.push({
            role: 'user', synthetic: true,
            content: 'You do have a real web_search tool right now, available in every message — you are not limited to your training data. Use it: reply with <tool>{"name": "web_search", "arguments": {"query": "..."}}</tool> for what I just asked, then answer from the results.'
          });
          bubble = addRow('assistant', '<p class="typing"><span></span><span></span><span></span></p>');
          continue;
        }
        setStatus('ok', 'Online');
        break;
      }

      const results = [];
      const toolLog = [];
      for (const call of calls) {
        // web_search gets its own persistent widget (renderSearch/finishSearch,
        // called inside execTool) instead of the generic tool card — showing
        // both was redundant.
        const card = call.name === 'web_search' ? null : addToolCard(call.name, call.args);
        let out, failed = false;
        const meta = {};
        try { out = await execTool(call.name, call.args, conv, meta); }
        catch (e) { out = `Tool error: ${e.message}`; failed = true; }
        if (card) finishToolCard(card, out, failed);
        if (!failed && (call.name === 'write_file' || call.name === 'deliver_file') && call.args.path) {
          addFileCard(call.args.path);
        }
        results.push(`[${call.name}] ->\n${String(out).slice(0, 6000)}`);
        toolLog.push({ name: call.name, args: call.args, output: out, failed, results: meta.results });
      }
      assistantMsg.tools = toolLog;
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
      const p = providerOf();
      const help = db.provider === 'corx'
        ? 'The model server may be offline, or its address may have changed — open <strong>Settings</strong> to update the endpoint, or the <a href="/chat/documentation/">set-up guide</a>.'
        : `Open <strong>Settings</strong> to check your ${esc(p.label)} key and model, or switch provider.`;
      bubble.innerHTML = `<p>${esc(err.message)}</p>` +
        `<p style="margin-top:8px;font-size:.85rem">${help}</p>`;
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
    if (!text && !(m.tools && m.tools.length)) continue;
    if (m.role === 'user') { addRow('user', renderMarkdown(text)); continue; }
    const { reasoning, answer } = splitThinking(text);
    const bubble = addRow('assistant', answer ? renderMarkdown(answer) : '');
    if (reasoning) paintReasoning(bubble, reasoning);
    if (m.tools && m.tools.length) replayTools(m.tools);
    if (!answer && m.tools && m.tools.length) bubble.remove();
  }
  if (conv.run?.active) showResumeBar(conv);
}

/* Rebuild the tool cards (and the search widget) a past round produced,
   from the structured log saved alongside the message — so a page refresh
   shows the same finished record the live run showed, not just the plain
   text the model saw. The search widget's sliding favicon row keeps
   animating here too, same as it does live — it's the same element type,
   just created already-closed instead of starting open. */
function replayTools(toolLog) {
  for (const t of toolLog) {
    if (t.name === 'web_search') {
      const box = renderSearch(t.args?.query || '');
      finishSearch(box, { query: t.args?.query || '', results: t.results, error: t.output });
      continue;
    }
    const card = addToolCard(t.name, t.args || {});
    finishToolCard(card, t.output, t.failed);
    if (!t.failed && (t.name === 'write_file' || t.name === 'deliver_file') && t.args?.path) {
      addFileCard(t.args.path);
    }
  }
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
  state.openFile = meta ? name : null; paintFiles();
  els.editorName.textContent = name;
  els.editor.hidden = false;
  if (!meta) {
    els.editorArea.value = 'This file no longer exists in the sandbox. The Python sandbox is ' +
      'in-memory and resets on a page refresh, so anything from before a reload is gone — ask ' +
      'the agent to recreate it if you still need it.';
    return;
  }
  if (/\.zip$/i.test(name)) {
    try {
      const r = await sandbox.runPython(
        'import zipfile\n' +
        `with zipfile.ZipFile(${JSON.stringify(meta.path)}) as _z:\n` +
        '    for _i in _z.infolist():\n' +
        '        print(f"{_i.file_size:>10}  {_i.filename}")'
      );
      els.editorArea.value = r.ok ? (r.output || '(empty zip)') : `(could not list zip contents: ${r.output})`;
    } catch (e) { els.editorArea.value = `(could not list zip contents: ${e.message})`; }
    return;
  }
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
    sheet: $('#settings'), endpoint: $('#set-endpoint'), key: $('#set-key'), model: $('#set-model'),
    providerGrid: $('#provider-grid'), providerHint: $('#provider-hint'),
    fieldEndpoint: $('#field-endpoint'), fieldKey: $('#field-key'), fieldModel: $('#field-model'),
    keyLink: $('#key-link'), keyNote: $('#key-note'), modelList: $('#model-list'),
    msMark: $('#ms-mark'), msName: $('#ms-name'), modelSwitch: $('#model-switch'),
    githubBtn: $('#github-btn'), githubSheet: $('#github-sheet'), ghToken: $('#gh-token'),
    ghLoad: $('#gh-load'), ghActive: $('#gh-active'), ghRepoList: $('#gh-repo-list'),
    ghSave: $('#gh-save'), ghCancel: $('#gh-cancel'),
    ghManual: $('#gh-manual'), ghManualAdd: $('#gh-manual-add'),
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
    // Clicking New chat while already sitting on an untouched "New chat"
    // used to stack another empty, identically-titled conversation on top
    // of it — same name, same nothing-in-it, no way to tell them apart in
    // the sidebar. Only actually create one if the current chat has
    // something in it.
    const cur = activeConv();
    if (!cur || cur.messages.some((m) => !m.synthetic)) newConversation();
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
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { closeSheet(); closeSidebar(); els.githubSheet.hidden = true; } });

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

  /* model & connection settings */
  let draftProvider = db.provider;   // provider being edited in the open sheet
  function renderProviderGrid() {
    els.providerGrid.innerHTML = '';
    for (const [id, p] of Object.entries(PROVIDERS)) {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'provider-chip';
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-checked', String(id === draftProvider));
      b.style.setProperty('--tint', p.tint);
      b.innerHTML = `<span class="pc-mark">${providerMark(p)}</span><span class="pc-label">${esc(p.label)}</span>` +
        (p.browser === false ? '<span class="pc-flag" title="Blocks direct browser calls">proxy</span>' : '');
      b.addEventListener('click', () => { draftProvider = id; syncSheetForProvider(); });
      els.providerGrid.appendChild(b);
    }
    wireBrandFallbacks(els.providerGrid);
  }
  function syncSheetForProvider() {
    const p = PROVIDERS[draftProvider];
    $$('.provider-chip', els.providerGrid).forEach((chip, i) => {
      chip.setAttribute('aria-checked', String(Object.keys(PROVIDERS)[i] === draftProvider));
    });
    els.providerHint.textContent = p.hint || '';
    // CorX shows the endpoint field; hosted providers show a key field.
    els.fieldEndpoint.hidden = draftProvider !== 'corx';
    els.fieldKey.hidden = !!p.keyless;
    if (!p.keyless) {
      els.key.value = db.keys[draftProvider] || '';
      if (p.keyUrl) { els.keyLink.href = p.keyUrl; els.keyLink.hidden = false; }
      else els.keyLink.hidden = true;
      els.keyNote.textContent = p.browser === false
        ? `${p.label} blocks browser calls, so this may fail with a CORS error. Stored in this browser only.`
        : 'Stored in this browser only, and sent only to this provider.';
    }
    // model suggestions
    els.modelList.innerHTML = (p.models || []).map((m) => `<option value="${esc(m)}">`).join('');
    els.model.value = db.modelByProvider[draftProvider] || (draftProvider === db.provider ? db.model : '') || p.models[0] || '';
  }
  const openSheet = () => {
    draftProvider = db.provider;
    els.endpoint.value = db.endpoint;
    renderProviderGrid(); syncSheetForProvider();
    els.sheet.hidden = false;
  };
  function closeSheet() { els.sheet.hidden = true; els.profileSheet.hidden = true; }
  $('#open-settings').addEventListener('click', openSheet);
  els.modelSwitch?.addEventListener('click', openSheet);
  $('#cancel-settings').addEventListener('click', closeSheet);
  els.sheet.addEventListener('click', (e) => { if (e.target === els.sheet) closeSheet(); });
  $('#save-settings').addEventListener('click', () => {
    const p = PROVIDERS[draftProvider];
    db.provider = draftProvider;
    if (draftProvider === 'corx') db.endpoint = els.endpoint.value.trim() || DEFAULTS.endpoint;
    if (!p.keyless) db.keys[draftProvider] = els.key.value.trim();
    const model = els.model.value.trim() || p.models[0];
    db.modelByProvider[draftProvider] = model;
    db.model = model;
    saveDb(); closeSheet(); paintModelLabel(); checkHealth();
  });
  paintModelLabel();

  /* github */
  const openGithub = () => {
    els.ghToken.value = db.github.token;
    els.ghRepoList.hidden = true; els.ghRepoList.innerHTML = '';
    paintGithub();
    els.githubSheet.hidden = false;
  };
  function closeGithub() { els.githubSheet.hidden = true; }
  function selectRepo(fullName, branch) {
    db.github.repo = fullName; db.github.branch = branch || '';
    saveDb(); paintGithub();
    $$('.gh-repo', els.ghRepoList).forEach((el) => el.setAttribute('aria-current', String(el.dataset.repo === fullName)));
  }
  els.githubBtn?.addEventListener('click', openGithub);
  els.ghCancel?.addEventListener('click', closeGithub);
  els.githubSheet?.addEventListener('click', (e) => { if (e.target === els.githubSheet) closeGithub(); });
  els.ghSave?.addEventListener('click', () => {
    db.github.token = els.ghToken.value.trim();
    if (!db.github.token) { db.github.repo = ''; db.github.branch = ''; }
    saveDb(); paintGithub(); closeGithub();
  });
  els.ghLoad?.addEventListener('click', async () => {
    db.github.token = els.ghToken.value.trim();
    if (!db.github.token) { els.ghLoad.textContent = 'Paste a token first'; return; }
    saveDb();
    els.ghLoad.disabled = true; els.ghLoad.textContent = 'Loading…';
    try {
      const { me, repos } = await ghListRepos();
      els.ghRepoList.hidden = false;
      if (!repos.length) {
        // Empty is almost always a token-scope problem, not a real absence of
        // repos — say exactly what to change instead of a blank "none found".
        els.ghRepoList.innerHTML =
          `<p class="panel-empty">Token works${me.login ? ` (signed in as <strong>${esc(me.login)}</strong>)` : ''}, but no repositories are visible to it.` +
          '<br><br>If it is a <strong>fine-grained</strong> token, open it on GitHub and set <strong>Repository access</strong> to “All repositories” (or add the ones you want), then give it <strong>Contents: read &amp; write</strong>. Save, and load again.' +
          '<br><br>Or just type the repo below.</p>';
      } else {
        els.ghRepoList.innerHTML = repos.map((r) =>
          `<button type="button" class="gh-repo" data-repo="${esc(r.full_name)}" data-branch="${esc(r.default_branch || 'main')}" aria-current="${r.full_name === db.github.repo}">` +
          `<span class="gh-repo-name">${esc(r.full_name)}</span>` +
          `<span class="gh-repo-meta">${r.private ? 'private' : 'public'} · ${esc(r.default_branch || 'main')}</span>` +
          `</button>`).join('');
        $$('.gh-repo', els.ghRepoList).forEach((el) =>
          el.addEventListener('click', () => selectRepo(el.dataset.repo, el.dataset.branch)));
      }
      els.ghLoad.textContent = repos.length ? `Loaded ${repos.length}` : 'Load my repositories';
    } catch (e) {
      els.ghRepoList.hidden = false;
      els.ghRepoList.innerHTML = `<p class="panel-empty" style="color:#b4453a">${esc(e.message)}</p>` +
        '<p class="panel-empty">A 401 means the token is wrong or revoked. A 403 usually means it is missing a permission.</p>';
      els.ghLoad.textContent = 'Load my repositories';
    } finally { els.ghLoad.disabled = false; }
  });
  /* Manual entry — always works, even when listing is blocked by token scope. */
  els.ghManualAdd?.addEventListener('click', async () => {
    const full = els.ghManual.value.trim().replace(/^https?:\/\/github\.com\//, '').replace(/\.git$/, '').replace(/\/+$/, '');
    if (!/^[^/]+\/[^/]+$/.test(full)) { els.ghManual.focus(); return; }
    db.github.token = els.ghToken.value.trim() || db.github.token;
    els.ghManualAdd.disabled = true; els.ghManualAdd.textContent = 'Checking…';
    try {
      const info = await gh('GET', `/repos/${full}`);
      selectRepo(info.full_name, info.default_branch || 'main');
      els.ghManualAdd.textContent = 'Selected';
      els.ghRepoList.hidden = false;
      els.ghRepoList.innerHTML = `<p class="panel-empty">Using <strong>${esc(info.full_name)}</strong> on <code>${esc(info.default_branch || 'main')}</code>.</p>`;
    } catch (e) {
      els.ghRepoList.hidden = false;
      els.ghRepoList.innerHTML = `<p class="panel-empty" style="color:#b4453a">${esc(e.message)}</p>`;
      els.ghManualAdd.textContent = 'Use this repo';
    } finally { els.ghManualAdd.disabled = false; }
  });
  paintGithub();

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
