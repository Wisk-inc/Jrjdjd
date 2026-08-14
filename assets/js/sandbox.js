/* ==========================================================================
   CorX Chat — the sandbox.

   Real Python, running in a WebAssembly VM inside the tab. Nothing here is
   simulated: commands are executed, output is whatever actually came back,
   and errors are real tracebacks.

   The VM has no access to your machine — only to its own in-memory filesystem
   and to the network through /api/fetch, which is a same-origin proxy so the
   sandbox is not boxed in by CORS.
   ========================================================================== */

const PYODIDE_URL = '/assets/vendor/pyodide/pyodide.mjs';
const INDEX_URL = '/assets/vendor/pyodide/';
const WORKDIR = '/work';

let pyodide = null;
let booting = null;
const listeners = new Set();

export const onOutput = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
const emit = (kind, text) => listeners.forEach((fn) => fn({ kind, text }));

/* The shim that gives Python real network access. Requests leave through our
   own origin, so the sandbox can reach sites that would otherwise refuse a
   cross-origin call from the browser. */
const NET_SHIM = `
import json as _json
from pyodide.http import pyfetch as _pyfetch


async def _corx(url, method="GET", headers=None, body=None):
    payload = {"url": url, "method": method, "headers": headers or {}, "body": body}
    res = await _pyfetch(
        "/api/fetch",
        method="POST",
        headers={"content-type": "application/json"},
        body=_json.dumps(payload),
    )
    return _json.loads(await res.string())


class Response:
    def __init__(self, raw):
        self.status = raw.get("status", 0)
        self.url = raw.get("url", "")
        self.headers = raw.get("headers", {})
        self.text = raw.get("body", "")
        self.error = raw.get("error")
        self.ok = 200 <= self.status < 300

    def json(self):
        return _json.loads(self.text)

    def __repr__(self):
        return "<Response [%s] %s>" % (self.status, self.url)


async def get(url, headers=None):
    "GET a URL through the CorX proxy. Returns a Response."
    return Response(await _corx(url, "GET", headers))


async def post(url, body=None, headers=None):
    "POST to a URL through the CorX proxy. Returns a Response."
    return Response(await _corx(url, "POST", headers, body))
`;

/* Registering the shim as a module by exec-ing it avoids hardcoding a
   site-packages path, which moves with the bundled Python version. */
const BOOT_PY = `
import os, sys, types

os.makedirs("${WORKDIR}", exist_ok=True)
os.chdir("${WORKDIR}")
if "${WORKDIR}" not in sys.path:
    sys.path.insert(0, "${WORKDIR}")

_web = types.ModuleType("web")
_web.__doc__ = "Internet access for the CorX sandbox: web.get(url) / web.post(url, body)."
exec(_SHIM_SRC, _web.__dict__)
sys.modules["web"] = _web
`;

export async function boot() {
  if (pyodide) return pyodide;
  if (booting) return booting;

  booting = (async () => {
    emit('sys', 'Starting Python sandbox…');
    const { loadPyodide } = await import(PYODIDE_URL);
    pyodide = await loadPyodide({
      indexURL: INDEX_URL,
      stdout: (line) => emit('out', line),
      stderr: (line) => emit('err', line)
    });
    pyodide.globals.set('_SHIM_SRC', NET_SHIM);
    await pyodide.runPythonAsync(BOOT_PY);
    pyodide.globals.delete('_SHIM_SRC');
    emit('sys', `Python ${pyodide.version} ready · cwd ${WORKDIR} · \`import web\` for internet access`);
    return pyodide;
  })();

  try {
    return await booting;
  } catch (err) {
    booting = null;
    emit('err', `Sandbox failed to start: ${err.message}`);
    throw err;
  }
}

export const isReady = () => Boolean(pyodide);

/* ------------------------------------------------------------------ python */
export async function runPython(code) {
  const py = await boot();
  emit('cmd', code);
  let result;
  try {
    result = await py.runPythonAsync(code);
  } catch (err) {
    const msg = String(err.message || err);
    emit('err', msg);
    return { ok: false, output: msg };
  }
  const text = result === undefined || result === null ? '' : String(result);
  if (text) emit('out', text);
  return { ok: true, output: text };
}

/* --------------------------------------------------------------- packages */
export async function installPackages(names) {
  const py = await boot();
  const list = Array.isArray(names) ? names : String(names).split(/\s+/).filter(Boolean);
  if (!list.length) return { ok: true, output: 'Nothing to install.' };
  emit('cmd', `pip install ${list.join(' ')}`);
  try {
    await py.loadPackage('micropip');
    const micropip = py.pyimport('micropip');
    await micropip.install(list);
    const msg = `Installed ${list.join(', ')}`;
    emit('ok', msg);
    return { ok: true, output: msg };
  } catch (err) {
    const msg = String(err.message || err);
    emit('err', msg);
    return { ok: false, output: msg };
  }
}

/* ------------------------------------------------------------- filesystem */
export async function writeFile(path, content) {
  const py = await boot();
  const full = path.startsWith('/') ? path : `${WORKDIR}/${path}`;
  const dir = full.slice(0, full.lastIndexOf('/'));
  if (dir) {
    try { py.FS.mkdirTree(dir); } catch { /* already there */ }
  }
  if (typeof content === 'string') {
    py.FS.writeFile(full, content, { encoding: 'utf8' });
  } else {
    py.FS.writeFile(full, new Uint8Array(content));
  }
  emit('ok', `wrote ${full}`);
  return { ok: true, output: `wrote ${full}` };
}

export async function readFile(path, binary = false) {
  const py = await boot();
  const full = path.startsWith('/') ? path : `${WORKDIR}/${path}`;
  try {
    return binary
      ? py.FS.readFile(full)
      : py.FS.readFile(full, { encoding: 'utf8' });
  } catch (err) {
    throw new Error(`No such file: ${full}`);
  }
}

export async function listFiles(dir = WORKDIR) {
  const py = await boot();
  const out = [];
  const walk = (base) => {
    let entries = [];
    try { entries = py.FS.readdir(base); } catch { return; }
    for (const name of entries) {
      if (name === '.' || name === '..') continue;
      const full = `${base}/${name}`.replace('//', '/');
      let stat;
      try { stat = py.FS.stat(full); } catch { continue; }
      if (py.FS.isDir(stat.mode)) walk(full);
      else out.push({ path: full, size: stat.size });
    }
  };
  walk(dir);
  return out;
}

export async function deleteFile(path) {
  const py = await boot();
  const full = path.startsWith('/') ? path : `${WORKDIR}/${path}`;
  py.FS.unlink(full);
  emit('ok', `removed ${full}`);
  return { ok: true, output: `removed ${full}` };
}

export const workdir = () => WORKDIR;

/* ------------------------------------------------------------------ shell
   A deliberately small command set. Anything beyond it is Python, which is
   the honest way round: this is a Python VM, not a Linux box. */
export async function runCommand(line) {
  const trimmed = line.trim();
  if (!trimmed) return { ok: true, output: '' };

  const [cmd, ...rest] = trimmed.split(/\s+/);
  const arg = rest.join(' ');

  switch (cmd) {
    case 'pip':
      if (rest[0] === 'install') return installPackages(rest.slice(1));
      return { ok: false, output: 'Only `pip install` is supported.' };
    case 'ls': {
      const files = await listFiles(arg || WORKDIR);
      const out = files.length
        ? files.map((f) => `${f.path}  ${f.size}B`).join('\n')
        : '(empty)';
      emit('cmd', trimmed); emit('out', out);
      return { ok: true, output: out };
    }
    case 'cat': {
      emit('cmd', trimmed);
      try {
        const text = await readFile(arg);
        emit('out', text);
        return { ok: true, output: text };
      } catch (err) {
        emit('err', err.message);
        return { ok: false, output: err.message };
      }
    }
    case 'rm':
      emit('cmd', trimmed);
      try { return await deleteFile(arg); }
      catch (err) { emit('err', err.message); return { ok: false, output: err.message }; }
    case 'python':
    case 'python3': {
      if (!arg) return { ok: false, output: 'Usage: python <file.py>' };
      emit('cmd', trimmed);
      const src = await readFile(arg).catch(() => null);
      if (src === null) {
        const msg = `No such file: ${arg}`;
        emit('err', msg);
        return { ok: false, output: msg };
      }
      return runPython(src);
    }
    case 'pwd':
      emit('cmd', trimmed); emit('out', WORKDIR);
      return { ok: true, output: WORKDIR };
    case 'help':
      emit('cmd', trimmed);
      emit('out', 'pip install <pkgs> · ls · cat <file> · rm <file> · python <file> · pwd\nAnything else is run as Python.');
      return { ok: true, output: '' };
    default:
      return runPython(trimmed);
  }
}
