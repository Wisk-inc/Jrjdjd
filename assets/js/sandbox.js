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

/* While a tap is set, everything the program prints is collected as well as
   shown. Without this the agent sees nothing from its own `print()` calls —
   the terminal would have the output and the model would not. */
let tap = null;
const emit = (kind, text) => {
  if (tap && (kind === 'out' || kind === 'err')) tap.push(String(text));
  listeners.forEach((fn) => fn({ kind, text }));
};

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

_fmt = types.ModuleType("fmt")
_fmt.__doc__ = "Archives and format conversion for the CorX sandbox."
exec(_FMT_SRC, _fmt.__dict__)
sys.modules["fmt"] = _fmt
`;

/* Archives and format conversion, as real code rather than something the model
   has to reinvent in Python each time it is asked. Everything here is stdlib
   except the image path, which asks micropip for Pillow on first use and says
   so plainly if that fails. Conversions between the tabular formats round-trip,
   which is what makes "convert it back" a real answer rather than a hope. */
const FMT_SHIM = `
import csv, io, json, os, re, tarfile, zipfile, base64, binascii

WORK = "${WORKDIR}"

TABULAR = {"csv", "tsv", "json", "jsonl", "ndjson", "md", "markdown", "html", "htm", "xml", "yaml", "yml"}
TEXTUAL = {"txt", "md", "markdown", "html", "htm", "log", "py", "js", "css", "sql", "sh", "c", "cpp", "java", "go", "rs", "rb", "php", "ts", "tsx", "jsx", "toml", "ini", "cfg"}
ARCHIVE = {"zip", "tar", "gz", "tgz"}
IMAGE = {"png", "jpg", "jpeg", "webp", "bmp", "gif", "tiff"}
BINARY_TEXT = {"b64", "base64", "hex"}

LOSSY = {"jpg", "jpeg"}


def _abs(p):
    p = str(p)
    return p if p.startswith("/") else os.path.join(WORK, p)


def ext(p):
    e = os.path.splitext(str(p))[1].lower().lstrip(".")
    if str(p).lower().endswith(".tar.gz"):
        return "tgz"
    return e


def supported():
    return {
        "tabular": sorted(TABULAR),
        "text": sorted(TEXTUAL),
        "archive": sorted(ARCHIVE),
        "image": sorted(IMAGE),
        "encoding": sorted(BINARY_TEXT),
    }


# ---------------------------------------------------------------- tabular I/O
def _rows_from_html(text):
    rows, cells = [], re.findall(r"<tr[^>]*>(.*?)</tr>", text, re.S | re.I)
    for tr in cells:
        cols = [re.sub(r"<[^>]+>", "", c).strip()
                for c in re.findall(r"<t[dh][^>]*>(.*?)</t[dh]>", tr, re.S | re.I)]
        if cols:
            rows.append(cols)
    if not rows:
        return []
    head = rows[0]
    return [dict(zip(head, r + [""] * (len(head) - len(r)))) for r in rows[1:]]


def _rows_from_md(text):
    lines = [l.strip() for l in text.splitlines() if l.strip().startswith("|")]
    if len(lines) < 2:
        return []
    split = lambda l: [c.strip() for c in l.strip().strip("|").split("|")]
    head = split(lines[0])
    body = [split(l) for l in lines[1:] if not re.match(r"^\\|[\\s:|-]+\\|?$", l)]
    return [dict(zip(head, r + [""] * (len(head) - len(r)))) for r in body]


def _rows_from_xml(text):
    import xml.etree.ElementTree as ET
    root = ET.fromstring(text)
    out = []
    for child in root:
        row = {c.tag: (c.text or "") for c in child}
        if not row and child.attrib:
            row = dict(child.attrib)
        if row:
            out.append(row)
    return out


def read_rows(path):
    """Read any tabular format into a list of dicts."""
    p, e = _abs(path), ext(path)
    with open(p, "r", encoding="utf-8", errors="replace") as f:
        text = f.read()
    if e == "csv":
        return list(csv.DictReader(io.StringIO(text)))
    if e == "tsv":
        return list(csv.DictReader(io.StringIO(text), delimiter="\\t"))
    if e in ("jsonl", "ndjson"):
        return [json.loads(l) for l in text.splitlines() if l.strip()]
    if e == "json":
        data = json.loads(text)
        if isinstance(data, list):
            return [d if isinstance(d, dict) else {"value": d} for d in data]
        return [data]
    if e in ("yaml", "yml"):
        import yaml
        data = yaml.safe_load(text)
        return data if isinstance(data, list) else [data]
    if e in ("html", "htm"):
        return _rows_from_html(text)
    if e in ("md", "markdown"):
        return _rows_from_md(text)
    if e == "xml":
        return _rows_from_xml(text)
    raise ValueError("Not a tabular format: ." + e)


def write_rows(rows, path):
    p, e = _abs(path), ext(path)
    rows = [dict(r) for r in rows]
    keys = []
    for r in rows:
        for k in r:
            if k not in keys:
                keys.append(k)
    os.makedirs(os.path.dirname(p) or WORK, exist_ok=True)

    if e in ("csv", "tsv"):
        buf = io.StringIO()
        # csv defaults to CRLF, which makes a csv -> json -> csv round trip differ
        # from the original by line ending alone. Keep it byte-for-byte.
        w = csv.DictWriter(buf, fieldnames=keys, delimiter=("\\t" if e == "tsv" else ","),
                           lineterminator="\\n", extrasaction="ignore")
        w.writeheader()
        for r in rows:
            w.writerow(r)
        text = buf.getvalue()
    elif e in ("jsonl", "ndjson"):
        text = "\\n".join(json.dumps(r, ensure_ascii=False) for r in rows) + "\\n"
    elif e == "json":
        text = json.dumps(rows, indent=2, ensure_ascii=False)
    elif e in ("yaml", "yml"):
        import yaml
        text = yaml.safe_dump(rows, sort_keys=False, allow_unicode=True)
    elif e in ("md", "markdown"):
        out = ["| " + " | ".join(keys) + " |",
               "| " + " | ".join("---" for _ in keys) + " |"]
        for r in rows:
            out.append("| " + " | ".join(str(r.get(k, "")) for k in keys) + " |")
        text = "\\n".join(out) + "\\n"
    elif e in ("html", "htm"):
        esc = lambda s: (str(s).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;"))
        out = ["<table>", "<thead><tr>" + "".join("<th>" + esc(k) + "</th>" for k in keys) + "</tr></thead>", "<tbody>"]
        for r in rows:
            out.append("<tr>" + "".join("<td>" + esc(r.get(k, "")) + "</td>" for k in keys) + "</tr>")
        out += ["</tbody>", "</table>"]
        text = "\\n".join(out) + "\\n"
    elif e == "xml":
        esc = lambda s: (str(s).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;"))
        out = ["<rows>"]
        for r in rows:
            out.append("  <row>")
            for k in keys:
                tag = re.sub(r"[^A-Za-z0-9_.-]", "_", str(k)) or "field"
                out.append("    <" + tag + ">" + esc(r.get(k, "")) + "</" + tag + ">")
            out.append("  </row>")
        out.append("</rows>")
        text = "\\n".join(out) + "\\n"
    else:
        raise ValueError("Cannot write tabular data as ." + e)

    with open(p, "w", encoding="utf-8") as f:
        f.write(text)
    return p


# ------------------------------------------------------------------ archives
def make_zip(paths, out="bundle.zip", compress=True):
    """Zip files and/or whole directories. Returns (path, [names])."""
    outp = _abs(out)
    mode = zipfile.ZIP_DEFLATED if compress else zipfile.ZIP_STORED
    names = []
    with zipfile.ZipFile(outp, "w", mode) as z:
        for raw in (paths if isinstance(paths, (list, tuple)) else [paths]):
            p = _abs(raw)
            if os.path.isdir(p):
                for root, _dirs, files in os.walk(p):
                    for fn in files:
                        full = os.path.join(root, fn)
                        arc = os.path.relpath(full, os.path.dirname(p.rstrip("/")))
                        z.write(full, arc)
                        names.append(arc)
            elif os.path.exists(p):
                arc = os.path.basename(p)
                z.write(p, arc)
                names.append(arc)
            else:
                raise FileNotFoundError(raw)
    return outp, names


def unpack(path, into=""):
    """Extract a zip/tar/tar.gz. Refuses entries that escape the target."""
    p = _abs(path)
    dest = _abs(into) if into else os.path.join(WORK, os.path.splitext(os.path.basename(p))[0])
    os.makedirs(dest, exist_ok=True)
    real_dest = os.path.realpath(dest)

    def safe(name):
        target = os.path.realpath(os.path.join(dest, name))
        return target == real_dest or target.startswith(real_dest + os.sep)

    names = []
    if zipfile.is_zipfile(p):
        with zipfile.ZipFile(p) as z:
            for n in z.namelist():
                if not safe(n):
                    raise ValueError("Refusing entry that escapes the target: " + n)
            z.extractall(dest)
            names = z.namelist()
    elif tarfile.is_tarfile(p):
        with tarfile.open(p) as t:
            for m in t.getmembers():
                if not safe(m.name):
                    raise ValueError("Refusing entry that escapes the target: " + m.name)
            t.extractall(dest)
            names = t.getnames()
    else:
        raise ValueError("Not a zip or tar archive: " + str(path))
    return dest, names


def list_archive(path):
    p = _abs(path)
    if zipfile.is_zipfile(p):
        with zipfile.ZipFile(p) as z:
            return [(i.filename, i.file_size) for i in z.infolist()]
    if tarfile.is_tarfile(p):
        with tarfile.open(p) as t:
            return [(m.name, m.size) for m in t.getmembers()]
    raise ValueError("Not an archive: " + str(path))


# ---------------------------------------------------------------- conversion
def _strip_tags(html):
    html = re.sub(r"(?is)<(script|style)[^>]*>.*?</\\1>", " ", html)
    html = re.sub(r"(?i)<br\\s*/?>", "\\n", html)
    html = re.sub(r"(?i)</p>", "\\n\\n", html)
    return re.sub(r"\\n{3,}", "\\n\\n", re.sub(r"<[^>]+>", "", html)).strip()


def _md_to_html(md):
    out = []
    for line in md.splitlines():
        h = re.match(r"^(#{1,6})\\s+(.*)$", line)
        if h:
            n = len(h.group(1))
            out.append("<h" + str(n) + ">" + h.group(2) + "</h" + str(n) + ">")
        elif line.strip():
            out.append("<p>" + line + "</p>")
    return "\\n".join(out) + "\\n"


def convert(src, dst):
    """Convert src to dst, inferring both formats from their extensions.
    Returns a one-line description of what happened."""
    sp, dp = _abs(src), _abs(dst)
    se, de = ext(src), ext(dst)
    if not os.path.exists(sp):
        raise FileNotFoundError(src)
    if se == de:
        raise ValueError("Source and target are both ." + se + " — nothing to convert.")

    # encodings, in both directions
    if de in BINARY_TEXT:
        raw = open(sp, "rb").read()
        enc = base64.b64encode(raw).decode() if de in ("b64", "base64") else raw.hex()
        open(dp, "w").write(enc)
        return "Encoded " + os.path.basename(sp) + " as " + de + " (" + str(len(enc)) + " chars)."
    if se in BINARY_TEXT:
        txt = open(sp).read().strip()
        raw = base64.b64decode(txt) if se in ("b64", "base64") else binascii.unhexlify(txt)
        open(dp, "wb").write(raw)
        return "Decoded " + se + " back to " + os.path.basename(dp) + " (" + str(len(raw)) + " bytes)."

    # archives
    if se in ARCHIVE and de not in ARCHIVE:
        dest, names = unpack(src, dst)
        return "Extracted " + str(len(names)) + " entries to " + dest + "."
    if de == "zip":
        outp, names = make_zip([src], dst)
        return "Zipped " + str(len(names)) + " entries into " + os.path.basename(outp) + "."

    # images
    if se in IMAGE or de in IMAGE:
        if se not in IMAGE or de not in IMAGE:
            raise ValueError("Images convert only to other image formats (" + ", ".join(sorted(IMAGE)) + ").")
        try:
            from PIL import Image
        except ImportError:
            raise ImportError("Image conversion needs Pillow. Run install_packages with "
                              "[\\"pillow\\"] first, then try again.")
        im = Image.open(sp)
        if de in ("jpg", "jpeg") and im.mode in ("RGBA", "P", "LA"):
            im = im.convert("RGB")
        im.save(dp)
        note = " (lossy — converting back will not restore the original pixels)" if de in LOSSY else ""
        return "Converted image " + se + " to " + de + ", " + str(im.width) + "x" + str(im.height) + note + "."

    # tabular both ends: the round-trippable path
    if se in TABULAR and de in TABULAR:
        rows = read_rows(src)
        write_rows(rows, dst)
        return ("Converted " + str(len(rows)) + " rows from " + se + " to " + de +
                ". Converting back gives the same rows.")

    # plain text shapes
    if se in ("html", "htm") and de in ("txt", "md", "markdown"):
        open(dp, "w").write(_strip_tags(open(sp, encoding="utf-8", errors="replace").read()))
        return "Stripped HTML to " + de + "."
    if se in ("md", "markdown") and de in ("html", "htm"):
        open(dp, "w").write(_md_to_html(open(sp, encoding="utf-8", errors="replace").read()))
        return "Rendered markdown to HTML."
    if se in TEXTUAL and de in TEXTUAL:
        open(dp, "w").write(open(sp, encoding="utf-8", errors="replace").read())
        return "Copied text from ." + se + " to ." + de + " unchanged."

    raise ValueError("No conversion from ." + se + " to ." + de + ". Supported: "
                     + json.dumps(supported()))


def sniff(path):
    """What is this file, really — type, size, and a readable preview."""
    p = _abs(path)
    if not os.path.exists(p):
        raise FileNotFoundError(path)
    size = os.path.getsize(p)
    e = ext(path)
    head = open(p, "rb").read(4096)
    kind = "binary"
    if e in ARCHIVE or zipfile.is_zipfile(p):
        try:
            entries = list_archive(p)
            return {"path": path, "size": size, "kind": "archive",
                    "entries": len(entries), "preview": entries[:25]}
        except Exception:
            pass
    if e in IMAGE:
        kind = "image"
    else:
        try:
            text = head.decode("utf-8")
            kind = "tabular" if e in TABULAR else "text"
            return {"path": path, "size": size, "kind": kind, "ext": e,
                    "preview": text[:1200]}
        except UnicodeDecodeError:
            pass
    return {"path": path, "size": size, "kind": kind, "ext": e,
            "preview": head[:64].hex()}
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
    pyodide.globals.set('_FMT_SRC', FMT_SHIM);
    await pyodide.runPythonAsync(BOOT_PY);
    pyodide.globals.delete('_SHIM_SRC');
    pyodide.globals.delete('_FMT_SRC');
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

/* ------------------------------------------------------------- javascript
   Real JavaScript, in a Worker. The site's CSP has no 'unsafe-eval', so eval()
   and new Function() are both dead ends — but worker-src allows blob:, and a
   Worker's source IS the blob. So the code is not evaluated, it is loaded as a
   script, which needs no policy change at all.

   Two things fall out of that for free: it runs off the main thread, so a long
   loop no longer freezes the tab the way long Python does, and it can be
   terminated, so Stop actually stops it. It reaches the network through the
   same /api/fetch proxy Python uses. It has no DOM and no access to the page. */
const JS_PREAMBLE = `
const __out = [];
const __ser = (v) => {
  if (typeof v === 'string') return v;
  if (v instanceof Error) return v.stack || String(v);
  try { const s = JSON.stringify(v, null, 2); return s === undefined ? String(v) : s; }
  catch { return String(v); }
};
const __log = (...a) => { if (__out.length < 5000) __out.push(a.map(__ser).join(' ')); };
self.console = { log: __log, info: __log, warn: __log, error: __log, debug: __log, table: __log };
const __call = async (url, method, body, headers) => {
  // A blob: worker's base URL is the blob itself, so a relative path here
  // throws "Failed to parse URL". __ORIGIN is baked in at creation.
  const r = await fetch(__ORIGIN + '/api/fetch', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ url, method, body, headers: headers || {} })
  });
  return r.json();
};
self.web = {
  get: (url, headers) => __call(url, 'GET', null, headers),
  post: (url, body, headers) => __call(url, 'POST', body, headers)
};
(async () => {
  try {
    const __v = await (async () => {
`;
const JS_POSTAMBLE = `
    })();
    self.postMessage({ ok: true, out: __out, value: __v === undefined ? '' : __ser(__v) });
  } catch (e) {
    self.postMessage({ ok: false, out: __out, error: __ser(e) });
  }
})();
`;

let jsWorker = null;
export function stopJs() {
  if (jsWorker) { jsWorker.terminate(); jsWorker = null; return true; }
  return false;
}

export function runJs(code, { timeoutMs = 0 } = {}) {
  emit('cmd', String(code));
  return new Promise((resolve) => {
    let url;
    try {
      const blob = new Blob([
        `const __ORIGIN = ${JSON.stringify(self.location.origin)};\n`,
        JS_PREAMBLE, String(code || ''), JS_POSTAMBLE
      ], { type: 'text/javascript' });
      url = URL.createObjectURL(blob);
      jsWorker = new Worker(url);
    } catch (e) {
      emit('err', String(e.message || e));
      return resolve({ ok: false, output: `Could not start the JS worker: ${e.message}` });
    }
    let done = false;
    const finish = (res) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      URL.revokeObjectURL(url);
      if (jsWorker) { jsWorker.terminate(); jsWorker = null; }
      resolve(res);
    };
    const timer = timeoutMs > 0 ? setTimeout(() => {
      emit('err', `Stopped after ${Math.round(timeoutMs / 1000)}s.`);
      finish({ ok: false, output: `Still running after ${Math.round(timeoutMs / 1000)}s and was stopped. ` +
        'Break the work into smaller pieces, or print progress as you go.' });
    }, timeoutMs) : null;

    jsWorker.onmessage = (ev) => {
      const d = ev.data || {};
      const printed = (d.out || []).join('\n');
      if (printed) emit('out', printed);
      if (!d.ok) {
        emit('err', d.error || 'unknown error');
        return finish({ ok: false, output: [printed, d.error].filter(Boolean).join('\n') });
      }
      if (d.value) emit('out', d.value);
      const body = [printed, d.value].filter(Boolean).join('\n');
      finish({ ok: true, output: body || '(no output)' });
    };
    // A syntax error in the supplied code surfaces here, not as a message.
    jsWorker.onerror = (ev) => {
      const msg = ev.message || 'Script error';
      emit('err', msg);
      finish({ ok: false, output: `${msg}${ev.lineno ? ` (line ${ev.lineno})` : ''}` });
    };
  });
}

/* --------------------------------------------------- archives and formats
   Thin wrappers over the `fmt` module above. These exist as their own tools
   rather than leaving the model to write the Python each time: a 27B gets
   zipfile and csv.DictWriter wrong often enough that the reliable path is to
   hand it a verb. Each returns the same {ok, output} shape as runPython. */
async function callFmt(expr, label) {
  const py = await boot();
  emit('cmd', label);
  try {
    const value = await py.runPythonAsync(`import fmt, json as _j\n_j.dumps(${expr})`);
    const out = JSON.parse(String(value));
    return { ok: true, output: out };
  } catch (err) {
    const msg = String(err.message || err).split('\n').filter(Boolean).pop() || String(err);
    emit('err', msg);
    return { ok: false, output: msg };
  }
}

const pyStr = (s) => JSON.stringify(String(s ?? ''));
const pyList = (a) => JSON.stringify((Array.isArray(a) ? a : [a]).map(String));

export async function makeZip(paths, out = 'bundle.zip', compress = true) {
  const r = await callFmt(
    `(lambda t: {"path": t[0], "names": t[1]})(fmt.make_zip(${pyList(paths)}, ${pyStr(out)}, ${compress ? 'True' : 'False'}))`,
    `zip -> ${out}`);
  if (!r.ok) return r;
  const { path, names } = r.output;
  return { ok: true, output: `Created ${path} with ${names.length} entr${names.length === 1 ? 'y' : 'ies'}: ${names.slice(0, 20).join(', ')}${names.length > 20 ? ', …' : ''}` };
}

export async function unpackArchive(path, into = '') {
  const r = await callFmt(
    `(lambda t: {"dest": t[0], "names": t[1]})(fmt.unpack(${pyStr(path)}, ${pyStr(into)}))`,
    `unpack ${path}`);
  if (!r.ok) return r;
  const { dest, names } = r.output;
  return { ok: true, output: `Extracted ${names.length} entries to ${dest}: ${names.slice(0, 20).join(', ')}${names.length > 20 ? ', …' : ''}` };
}

export async function convertFile(src, dst) {
  return callFmt(`fmt.convert(${pyStr(src)}, ${pyStr(dst)})`, `convert ${src} -> ${dst}`);
}

export async function inspectFile(path) {
  const r = await callFmt(`fmt.sniff(${pyStr(path)})`, `inspect ${path}`);
  if (!r.ok) return r;
  const d = r.output;
  const head = `${d.path} — ${d.kind}${d.ext ? ` (.${d.ext})` : ''}, ${d.size} bytes`;
  const body = d.kind === 'archive'
    ? `${d.entries} entries:\n` + d.preview.map(([n, s]) => `  ${n} (${s}B)`).join('\n')
    : String(d.preview || '').slice(0, 1200);
  return { ok: true, output: `${head}\n${body}` };
}

export async function formatSupport() {
  const r = await callFmt('fmt.supported()', 'formats');
  if (!r.ok) return r;
  return { ok: true, output: Object.entries(r.output).map(([k, v]) => `${k}: ${v.join(' ')}`).join('\n') };
}

/* ------------------------------------------------------------------ python */
export async function runPython(code) {
  const py = await boot();
  emit('cmd', code);

  const printed = [];
  const outer = tap;
  tap = printed;
  try {
    let result, error = null;
    try { result = await py.runPythonAsync(code); }
    catch (err) { error = String(err.message || err); }

    if (error) {
      emit('err', error);
      // The caller (and the model, in agent mode) needs the actual failure
      // reason to fix it — not just whatever printed before the exception.
      const combined = [printed.join('\n'), error].filter(Boolean).join('\n');
      return { ok: false, output: combined };
    }
    const value = result === undefined || result === null ? '' : String(result);
    if (value) emit('out', value);
    return { ok: true, output: printed.join('\n') };
  } finally {
    tap = outer;
  }
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
