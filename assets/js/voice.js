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

const els = {};
let mode = 'convert';
let connected = false;
let busy = false;
let lastUrl = null;

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

    if (!info.ok) {
      connected = false;
      setStatus('error', 'Model not ready');
      setMsg(info.detail || 'The server is up but the model did not load.', 'warn');
      return false;
    }

    connected = true;
    try { localStorage.setItem(KEY, url); } catch (e) { /* private window */ }
    setStatus('ready', (info.device || '').toUpperCase() || 'Ready');
    const path = info.mode === 'streams'
      ? 'driving the three streams separately'
      : 'using the repo’s own conversion call';
    setMsg('Connected to ' + (info.model || 'TriStream') + ' on '
      + (info.device || '?') + ', ' + path + '.', 'ok');
    return true;
  } catch (err) {
    connected = false;
    setStatus('error', 'Unreachable');
    setMsg('Could not reach that URL. Quick-tunnel addresses change every time the cell is '
      + 'restarted, so check the latest one. (' + err.message + ')', 'warn');
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
  if (!els.endpoint.value) {
    try {
      const saved = localStorage.getItem(KEY);
      if (saved) els.endpoint.value = saved;
    } catch (e) { /* private window */ }
  }
  if (els.endpoint.value && !connected) connect(true);
  els.endpoint.focus();
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
