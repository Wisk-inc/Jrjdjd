/* CorX Labs — Voice studio
   TriStream-SVS inside the chat, talking to a server the user runs themselves.

   Kept in its own module rather than folded into chat.js: the chat's streaming
   path has been debugged hard and there is no reason for an audio panel to be
   able to break it. Nothing here touches the conversation state.

   The two clips map onto the architecture rather than onto a generic
   any-to-any conversion:

     the voice to clone  -> speaker encoder -> FILTER stream (the only stream
                            that carries identity)
     the performance     -> F0 + voiced flag -> SOURCE stream (structurally
                            incapable of carrying timbre)
                         -> mel              -> RESIDUAL stream (breath,
                            fricatives, articulation)

   which is why the result sings the performance in the other singer's voice. */
'use strict';

const $ = (sel) => document.querySelector(sel);

const KEY = 'corx.voice.endpoint';
const MAX_BYTES = 40 * 1024 * 1024;

/* Kept in step with BUILD in chat/tristream-server.py. A server running an
   older copy of the script looks identical to one running the current copy
   until it behaves differently, and working that out from symptoms costs a
   round trip every time. /health reports its build, so say so directly. */
const SERVER_BUILD = 6;

function staleBuild(info) {
  const got = Number(info && info.build) || 0;
  return got < SERVER_BUILD
    ? 'That server is running build ' + (got || 'older than 6') + ' of the script; this page '
      + 'expects build ' + SERVER_BUILD + '. Press “Copy server code” above and re-run it — '
      + 'fixes since then will not be in the copy you have.'
    : '';
}

/* --- remembering the endpoint ----------------------------------------------
   A quick-tunnel address is single use: cloudflared mints a new hostname every
   time it starts and the previous one stops resolving. Restoring one from a
   previous session and connecting to it on sight is therefore wrong most of the
   time — it fails, or worse, opening it lands on a Cloudflare error page, which
   reads like a broken server rather than an expired address. So the address is
   stored with the time it last worked, and anything older is offered rather
   than used. */
const ENDPOINT_FRESH_MS = 6 * 60 * 60 * 1000;

function saveEndpoint(url) {
  try {
    localStorage.setItem(KEY, JSON.stringify({ url: url, at: Date.now() }));
  } catch (e) { /* private window */ }
}

function loadEndpoint() {
  let raw;
  try {
    raw = localStorage.getItem(KEY);
  } catch (e) {
    return null;                       // private window
  }
  if (!raw) return null;
  // Entries written before this carried a bare URL and no timestamp; an
  // undated address is exactly the kind that has had time to expire.
  if (raw[0] !== '{') return { url: raw, aged: true };
  try {
    const saved = JSON.parse(raw);
    if (!saved || !saved.url) return null;
    return { url: saved.url, aged: !(Date.now() - (saved.at || 0) < ENDPOINT_FRESH_MS) };
  } catch (e) {
    return null;
  }
}

const els = {};
let mode = 'convert';
let connected = false;
let busy = false;
let lastUrl = null;
let lastHealth = null;

function setMsg(text, kind) {
  if (!els.msg) return;
  els.msg.hidden = !text;
  els.msg.textContent = text || '';
  els.msg.dataset.kind = kind || '';
}

function setStatus(state, label) {
  if (!els.status) return;
  els.status.dataset.state = state;
  const l = els.status.querySelector('.status-label');
  if (l) l.textContent = label;
}

function cleanEndpoint(value) {
  let v = (value || '').trim().replace(/\/+$/, '');
  if (v && !/^https?:\/\//i.test(v)) v = 'https://' + v;
  return v;
}

/* --- copying the server code ------------------------------------------------
   The script is a real file at /chat/tristream-server.py rather than 600 lines
   inlined into this page, so the chat does not carry 24KB it almost never uses.

   It is fetched when the panel opens, not when the button is pressed: a
   clipboard write has to happen while the click still counts as a user
   gesture, and awaiting a network round trip inside the handler can outlive
   that and fail with NotAllowedError. Prefetching makes the common press a
   straight write. */
const SERVER_URL = '/chat/tristream-server.py';
let serverSrc = null;
let serverFetch = null;

function fetchServer() {
  if (serverSrc) return Promise.resolve(serverSrc);
  if (!serverFetch) {
    // cache: 'no-store' on purpose. This file changes when a bug is fixed, and
    // a browser handing back yesterday's copy means running yesterday's bugs —
    // which has already happened once, and is indistinguishable from the fix
    // not working.
    serverFetch = fetch(SERVER_URL, { credentials: 'omit', cache: 'no-store' })
      .then((r) => {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.text();
      })
      .then((t) => {
        // A misrouted request can hand back the SPA shell with a 200. Anything
        // that is not the script is worse than useless on a clipboard.
        if (!t || t.length < 2000 || t.lastIndexOf('# TriStream-SVS server', 400) === -1) {
          throw new Error('unexpected file contents');
        }
        serverSrc = t;
        return t;
      })
      .catch((e) => { serverFetch = null; throw e; });
  }
  return serverFetch;
}

/* Clipboard first, then a hidden textarea: the modern API is refused outright
   in a few settings where execCommand still works, and a copy button that
   silently does nothing is the worst outcome here. */
async function toClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (e) { /* fall through */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;top:0;left:-9999px;opacity:0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch (e) {
    return false;
  }
}

function flash(btn, label) {
  if (!btn) return;
  if (btn.dataset.idle === undefined) btn.dataset.idle = btn.textContent;
  btn.textContent = label;
  clearTimeout(Number(btn.dataset.timer));
  btn.dataset.timer = String(setTimeout(() => { btn.textContent = btn.dataset.idle; }, 2200));
}

async function copyServer() {
  const btn = els.copy;
  flash(btn, 'Copying…');
  let src;
  try {
    src = await fetchServer();
  } catch (err) {
    flash(btn, 'Copy server code');
    setMsg('Could not load the script (' + err.message + '). Open it with “View it first” and '
      + 'copy it from there, or get it from the set-up guide.', 'warn');
    return;
  }
  if (await toClipboard(src)) {
    // The file ends with a newline; counting the split parts would claim one
    // line more than the script actually has.
    const lines = src.replace(/\n$/, '').split('\n').length;
    flash(btn, 'Copied ' + lines + ' lines');
    setMsg('On the clipboard. Paste it into a file called tristream-server.py on the machine with '
      + 'the GPU, or into one notebook cell.', 'ok');
  } else {
    flash(btn, 'Copy server code');
    setMsg('This browser blocked the clipboard. Open the script with “View it first” and copy it '
      + 'from the tab.', 'warn');
  }
}

/* --- file slots ------------------------------------------------------------
   Each slot previews what was picked. Object URLs are revoked on replacement:
   a few of these per session is nothing, but a panel someone leaves open while
   auditioning twenty takes should not leak twenty decoded files. */
function wireSlot(input, nameEl, audioEl) {
  if (!input) return;
  input.addEventListener('change', () => {
    const file = input.files && input.files[0];
    if (!file) {
      nameEl.textContent = 'No file chosen';
      if (audioEl) { audioEl.hidden = true; audioEl.removeAttribute('src'); }
      return;
    }
    if (file.size > MAX_BYTES) {
      input.value = '';
      nameEl.textContent = 'No file chosen';
      setMsg('That clip is ' + (file.size / 1048576).toFixed(0) + 'MB. Keep it under 40MB — '
        + 'a few seconds of clean singing clones better than a whole track anyway.', 'warn');
      return;
    }
    nameEl.textContent = file.name + ' · ' + (file.size / 1024).toFixed(0) + ' KB';
    if (audioEl) {
      if (audioEl.dataset.blob) URL.revokeObjectURL(audioEl.dataset.blob);
      const url = URL.createObjectURL(file);
      audioEl.dataset.blob = url;
      audioEl.src = url;
      audioEl.hidden = false;
    }
    setMsg('');
  });
}

/* --- connect ---------------------------------------------------------------
   /health is the only endpoint worth trusting before sending audio: the server
   reports which entry point it managed to bind to inside the model repo, and
   whether that is the real stream-level transplant or the repo's own
   conversion call. Surfacing that here means a user knows what they are about
   to get rather than finding out from the output. */
async function connect(quiet) {
  const url = cleanEndpoint(els.endpoint.value);
  if (!url) {
    if (!quiet) setMsg('Paste the URL the TriStream cell printed.', 'warn');
    return false;
  }
  els.endpoint.value = url;
  setStatus('checking', 'Checking…');
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 12000);
    const res = await fetch(url + '/health', { signal: ctrl.signal, credentials: 'omit' });
    clearTimeout(timer);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const info = await res.json();

    if (info.loading) {
      // The server now answers while the model is still loading, so this is a
      // normal state on a first run, not a failure.
      connected = false;
      lastHealth = info;
      // Clear anything left over from a previous failure — a stale diagnostics
      // button here would describe a problem that is no longer the problem.
      if (els.diag) els.diag.hidden = true;
      if (els.open) els.open.hidden = true;
      setStatus('checking', 'Loading…');
      setMsg('The server is up and still loading — first run downloads PyTorch and the '
        + 'weights, which takes a few minutes. Press Connect again in a moment.', '');
      return false;
    }

    if (!info.ok) {
      // The tunnel works and the server answered — the model just did not bind.
      // /health carries the repo's file list and every attempt made, which is
      // what actually identifies the problem, so keep it copyable rather than
      // truncating it into the message line.
      connected = false;
      lastHealth = info;
      if (els.diag) els.diag.hidden = false;
      setStatus('error', 'Model not ready');
      const stale = staleBuild(info);
      setMsg(stale || ((info.detail || 'The server is up but the model did not load.')
        + ' The server reached it and the tunnel is fine — this is the weights '
        + 'failing to load, not the connection.'), 'warn');
      setupPending(true);
      return false;
    }
    lastHealth = info;
    if (els.diag) els.diag.hidden = true;
    if (els.open) els.open.hidden = true;

    connected = true;
    saveEndpoint(url);
    setStatus('ready', (info.device || '').toUpperCase() || 'Ready');
    // The three steps are a one-off per machine. Once the server answers, get
    // them out of the way and leave the panel on the part that gets used.
    setupDone(info.gpu || info.device);
    const path = info.mode === 'streams'
      ? 'driving the three streams separately'
      : 'using the repo’s own conversion call';
    const stale = staleBuild(info);
    // A CPU fallback connects and then takes minutes per clip. Saying "cuda"
    // vs "cpu" in the status pill is too quiet for something that decides
    // whether this is usable at all.
    const onCpu = (info.device || '').toLowerCase() === 'cpu'
      ? ' It is running on CPU, not a GPU — synthesis will be far too slow to be'
        + ' usable. Check the runtime actually has a GPU attached.'
      : '';
    setMsg('Connected to ' + (info.model || 'TriStream') + ' on '
      + (info.device || '?') + ', ' + path + '.' + (stale ? ' ' + stale : '') + onCpu,
      (stale || onCpu) ? 'warn' : 'ok');
    return true;
  } catch (err) {
    connected = false;
    setStatus('error', 'Unreachable');
    // "Failed to fetch" covers three different situations and the browser will
    // not say which, so name them instead of repeating the generic message.
    // The useful move is opening the URL in a tab: a Cloudflare error page means
    // the tunnel is up but nothing is listening behind it.
    const aborted = err.name === 'AbortError';
    setMsg(aborted
      ? 'That URL did not answer within 12 seconds. If the server is mid-load it will '
        + 'answer shortly — try Connect again.'
      : 'No answer from that URL. Three things do this: the address is from a previous '
        + 'run (quick-tunnel addresses change on every restart), the cell has stopped, or '
        + 'the server crashed while loading and the tunnel is still up with nothing behind '
        + 'it. Open ' + url + '/health in a new tab — a Cloudflare error page means the '
        + 'server is gone, so check the cell’s output. (' + err.message + ')', 'warn');
    if (els.open) {
      els.open.href = url + '/health';
      els.open.hidden = false;
    }
    setupPending(true);
    return false;
  }
}

/* --- generate -------------------------------------------------------------- */
async function generate() {
  if (busy) return;
  const url = cleanEndpoint(els.endpoint.value);
  if (!url) { setMsg('Paste the server URL first.', 'warn'); return; }
  if (!connected && !(await connect(true))) return;

  const voice = els.ref.files && els.ref.files[0];
  if (!voice) { setMsg('Choose the voice you want to clone.', 'warn'); return; }

  const body = new FormData();
  body.append('voice', voice);
  body.append('pitch_shift', els.pitch.value);
  body.append('steps', els.steps.value);

  let endpoint;
  if (mode === 'convert') {
    const perf = els.perf.files && els.perf.files[0];
    if (!perf) { setMsg('Choose the performance you want it to sing.', 'warn'); return; }
    body.append('performance', perf);
    body.append('residual_from', els.residual.value);
    endpoint = '/v1/voice/convert';
  } else {
    const lyrics = (els.lyrics.value || '').trim();
    if (!lyrics) { setMsg('Write the lyrics you want it to sing.', 'warn'); return; }
    body.append('lyrics', lyrics);
    const melody = els.melody.files && els.melody.files[0];
    if (melody) body.append('melody', melody);
    endpoint = '/v1/voice/generate';
  }

  busy = true;
  els.go.disabled = true;
  els.go.textContent = 'Generating…';
  setMsg('Running the flow-matching decoder. A few seconds of audio takes about that many '
    + 'seconds on a warm GPU, and rather longer on the first run while weights load.', '');

  try {
    const res = await fetch(url + endpoint, { method: 'POST', body, credentials: 'omit' });
    if (!res.ok) {
      let detail = 'HTTP ' + res.status;
      try {
        const j = await res.json();
        if (j && (j.error || j.detail)) detail = j.error || j.detail;
      } catch (e) { /* not json */ }
      throw new Error(detail);
    }
    const blob = await res.blob();
    if (lastUrl) URL.revokeObjectURL(lastUrl);
    lastUrl = URL.createObjectURL(blob);

    els.audio.src = lastUrl;
    els.download.href = lastUrl;
    els.download.download = 'tristream-' + Date.now() + '.wav';
    els.out.hidden = false;

    const path = res.headers.get('X-TriStream-Path');
    const secs = res.headers.get('X-TriStream-Seconds');
    els.note.textContent = [
      (blob.size / 1024).toFixed(0) + ' KB WAV',
      secs ? secs + 's' : null,
      path || null,
    ].filter(Boolean).join(' · ');

    setMsg('');
    els.audio.play().catch(() => { /* autoplay blocked; the controls still work */ });
  } catch (err) {
    setMsg('Generation failed: ' + err.message, 'warn');
  } finally {
    busy = false;
    els.go.disabled = false;
    els.go.textContent = 'Generate';
  }
}

/* --- set-up tutorial -------------------------------------------------------- */
function setupDone(where) {
  if (!els.setup) return;
  els.setup.open = false;
  els.setup.dataset.state = 'done';
  if (els.setupHint) {
    els.setupHint.textContent = where ? 'server running on ' + where : 'server running';
  }
}

/* `expand` only when something failed. Resetting the label while someone edits
   the URL should not make the panel jump open under their cursor. */
function setupPending(expand) {
  if (!els.setup) return;
  els.setup.dataset.state = '';
  if (els.setupHint) els.setupHint.textContent = 'three steps, once per machine';
  if (expand) els.setup.open = true;
}

/* --- mode ------------------------------------------------------------------ */
function setMode(next) {
  mode = next;
  document.querySelectorAll('.voice-mode').forEach((b) => {
    const on = b.dataset.mode === next;
    b.classList.toggle('is-on', on);
    b.setAttribute('aria-selected', String(on));
  });
  document.querySelectorAll('.voice-slot[data-for]').forEach((slot) => {
    slot.hidden = slot.dataset.for !== next;
  });
}

/* --- open / close ---------------------------------------------------------- */
function open() {
  els.sheet.hidden = false;
  let aged = false;
  if (!els.endpoint.value) {
    const saved = loadEndpoint();
    if (saved) {
      els.endpoint.value = saved.url;
      aged = saved.aged;
    }
  }

  // Warm the clipboard copy so pressing the button is a straight write.
  fetchServer().catch(() => { /* reported at press time, not before */ });

  const returning = !!els.endpoint.value;
  if (els.setup && returning && !aged) els.setup.open = false;

  if (aged) {
    // Do not auto-connect to an address that is almost certainly dead. Opening
    // it just produces a Cloudflare error page, which reads like the server
    // broke rather than like the address expired.
    setStatus('idle', 'Address may be stale');
    setMsg('That address is from an earlier session. Quick-tunnel addresses are single '
      + 'use — the cell prints a new one every time it starts, and the old one stops '
      + 'resolving, which is what a Cloudflare error page means. Paste the newest URL '
      + 'from the cell output, or press Connect to try this one anyway.', 'warn');
  } else if (returning && !connected) {
    connect(true);
  }

  // A first-timer belongs on step 1; someone with a server saved belongs on
  // the URL box, ready to paste the address this session's tunnel printed.
  if (returning) els.endpoint.focus();
  else els.copy?.focus();
}

function close() { els.sheet.hidden = true; }

/* --- init ------------------------------------------------------------------ */
function init() {
  els.sheet = $('#voice-sheet');
  if (!els.sheet) return;

  Object.assign(els, {
    btn: $('#voice-btn'), endpoint: $('#voice-endpoint'), status: $('#voice-status'),
    connectBtn: $('#voice-connect'), ref: $('#voice-ref'), perf: $('#voice-perf'),
    melody: $('#voice-melody'), lyrics: $('#voice-lyrics'), residual: $('#voice-residual'),
    pitch: $('#voice-pitch'), steps: $('#voice-steps'), go: $('#voice-go'),
    closeBtn: $('#voice-close'), out: $('#voice-out'), audio: $('#voice-audio'),
    download: $('#voice-download'), note: $('#voice-out-note'), msg: $('#voice-msg'),
    setup: $('#voice-setup'), setupHint: $('#voice-setup-hint'),
    copy: $('#voice-copy'), copyCmd: $('#voice-copy-cmd'), cmd: $('#voice-cmd'),
    diag: $('#voice-diag'), open: $('#voice-open'),
  });

  els.diag?.addEventListener('click', async () => {
    if (!lastHealth) return;
    const ok = await toClipboard(JSON.stringify(lastHealth, null, 2));
    flash(els.diag, ok ? 'Copied' : 'Blocked');
  });

  els.copy?.addEventListener('click', copyServer);
  els.copyCmd?.addEventListener('click', async () => {
    const ok = await toClipboard(els.cmd.textContent.trim());
    flash(els.copyCmd, ok ? 'Copied' : 'Blocked');
  });

  wireSlot(els.ref, $('#voice-ref-name'), $('#voice-ref-audio'));
  wireSlot(els.perf, $('#voice-perf-name'), $('#voice-perf-audio'));
  wireSlot(els.melody, $('#voice-melody-name'), null);

  els.btn?.addEventListener('click', open);
  els.closeBtn?.addEventListener('click', close);
  els.sheet.addEventListener('click', (e) => { if (e.target === els.sheet) close(); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !els.sheet.hidden) close();
  });

  els.connectBtn?.addEventListener('click', () => connect(false));
  els.endpoint?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); connect(false); }
  });
  els.endpoint?.addEventListener('input', () => {
    connected = false;
    setStatus('idle', 'Not connected');
    setupPending();
  });

  document.querySelectorAll('.voice-mode').forEach((b) => {
    b.addEventListener('click', () => setMode(b.dataset.mode));
  });

  els.pitch?.addEventListener('input', () => {
    const v = Number(els.pitch.value);
    $('#voice-pitch-val').textContent = v > 0 ? '+' + v : String(v);
  });
  els.steps?.addEventListener('input', () => {
    $('#voice-steps-val').textContent = els.steps.value;
  });

  els.go?.addEventListener('click', generate);
  setMode('convert');
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
