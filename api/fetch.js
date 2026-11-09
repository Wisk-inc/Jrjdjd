/* POST /api/fetch — the sandbox's way onto the internet.

   Python running in the browser VM can only make same-origin requests, so
   `web.get(url)` comes here and this forwards it. That is what makes the
   terminal's network access real rather than CORS-limited.

   Guards: https/http only, no credentials forwarded, private and
   loopback addresses refused (IPv4 and IPv6, on the first address and on
   every redirect), response size capped. */

export const config = { runtime: 'edge' };

const MAX_BYTES = 2_000_000;
const TIMEOUT_MS = 20_000;

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
  });

const MAX_REDIRECTS = 5;
const METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'];

/* Block anything that would let the sandbox poke at infrastructure rather
   than the public web. `hostname` comes from the URL parser, which has
   already turned decimal, hex and octal IPv4 spellings into a dotted quad
   and wraps an IPv6 literal in square brackets. */
const isBlockedV4 = ([a, b]) =>
  a === 0 || a === 10 || a === 127 ||        // this network, private, loopback
  (a === 100 && b >= 64 && b <= 127) ||      // carrier-grade NAT
  (a === 169 && b === 254) ||                // link-local / cloud metadata
  (a === 172 && b >= 16 && b <= 31) ||       // private
  (a === 192 && b === 168) ||                // private
  (a === 198 && (b === 18 || b === 19)) ||   // benchmarking range
  a >= 224;                                  // multicast and reserved

const isBlockedV6 = (h) => {
  if (h === '::' || h === '::1') return true;        // unspecified, loopback
  if (/^f[cd][0-9a-f]{2}:/.test(h)) return true;    // unique local, fc00::/7
  if (/^fe[89ab][0-9a-f]:/.test(h)) return true;    // link-local, fe80::/10
  if (h.startsWith('ff')) return true;               // multicast
  // An IPv4 address carried inside IPv6: mapped (::ffff:), NAT64 (64:ff9b::)
  // or the old "compatible" form (::a.b.c.d). The parser prints the last 32
  // bits as two hex groups, so read them back as the four octets.
  const v4 = h.match(/^(?:::ffff:|64:ff9b::|::)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (v4) {
    const hi = parseInt(v4[1], 16); const lo = parseInt(v4[2], 16);
    return isBlockedV4([hi >> 8, hi & 255, lo >> 8, lo & 255]);
  }
  return false;
};

export const isBlockedHost = (hostname) => {
  const h = String(hostname).toLowerCase().replace(/\.$/, '');
  if (h.startsWith('[') && h.endsWith(']')) return isBlockedV6(h.slice(1, -1));
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.internal') || h.endsWith('.local')) return true;
  const quad = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  return quad ? isBlockedV4(quad.slice(1).map(Number)) : false;
};

const isAllowedTarget = (u) => (u.protocol === 'https:' || u.protocol === 'http:') && !isBlockedHost(u.hostname);

export default async function handler(request) {
  if (request.method !== 'POST') return json({ error: 'Use POST.' }, 405);

  let payload;
  try {
    payload = await request.json();
  } catch {
    return json({ error: 'Body must be JSON.' }, 400);
  }
  if (!payload || typeof payload !== 'object') return json({ error: 'Body must be a JSON object.' }, 400);

  let target;
  try {
    target = new URL(String(payload.url || ''));
  } catch {
    return json({ error: 'Invalid url.' }, 400);
  }

  if (target.protocol !== 'https:' && target.protocol !== 'http:') {
    return json({ error: 'Only http and https are allowed.' }, 400);
  }
  if (isBlockedHost(target.hostname)) {
    return json({ error: 'That host is not reachable from the sandbox.' }, 403);
  }

  const method = String(payload.method || 'GET').toUpperCase();
  if (!METHODS.includes(method)) return json({ error: `Method ${method.slice(0, 20)} is not allowed.` }, 400);
  const headers = new Headers();
  // Only a safe subset of caller headers is forwarded.
  const allowed = ['accept', 'content-type', 'user-agent'];
  for (const [k, v] of Object.entries(payload.headers || {})) {
    if (allowed.includes(String(k).toLowerCase())) headers.set(k, String(v));
  }
  if (!headers.has('user-agent')) headers.set('user-agent', 'CorX-Chat-Sandbox/1.0 (+https://corx-labs.com/chat/)');
  if (!headers.has('accept')) headers.set('accept', '*/*');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    /* Redirects are followed by hand so that every hop passes the same checks
       as the first address: a public page must not be able to bounce the
       sandbox onto a private one. */
    let current = target;
    let hopMethod = method;
    let hopBody;
    if (!['GET', 'HEAD'].includes(method) && payload.body != null) {
      hopBody = typeof payload.body === 'string' ? payload.body : JSON.stringify(payload.body);
    }
    let res;
    for (let hop = 0; ; hop++) {
      res = await fetch(current.toString(), {
        method: hopMethod,
        headers,
        body: hopBody,
        redirect: 'manual',
        signal: controller.signal
      });
      const location = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null;
      if (!location) break;
      let next;
      try {
        next = new URL(location, current);
      } catch {
        break;
      }
      if (hop >= MAX_REDIRECTS) {
        return json({ status: 0, url: next.toString(), headers: {}, body: '', error: 'Too many redirects.' });
      }
      if (!isAllowedTarget(next)) {
        return json({ status: 0, url: next.toString(), headers: {}, body: '', error: 'Redirected to a host that is not reachable from the sandbox.' });
      }
      // As browsers do: 303 always becomes a GET, 301 and 302 turn a POST into
      // a GET, and 307 and 308 keep the method and body.
      if (res.status === 303 || ((res.status === 301 || res.status === 302) && hopMethod === 'POST')) {
        hopMethod = 'GET';
        hopBody = undefined;
      }
      await res.body?.cancel().catch(() => {});
      current = next;
    }

    const reader = res.body?.getReader();
    let received = 0;
    const chunks = [];
    if (reader) {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        received += value.byteLength;
        if (received > MAX_BYTES) {
          await reader.cancel();
          break;
        }
        chunks.push(value);
      }
    }
    const merged = new Uint8Array(received > MAX_BYTES ? MAX_BYTES : received);
    let offset = 0;
    for (const c of chunks) {
      if (offset + c.length > merged.length) {
        merged.set(c.subarray(0, merged.length - offset), offset);
        break;
      }
      merged.set(c, offset);
      offset += c.length;
    }

    const outHeaders = {};
    for (const [k, v] of res.headers.entries()) {
      if (['content-type', 'content-length', 'last-modified', 'etag'].includes(k)) {
        outHeaders[k] = v;
      }
    }

    return json({
      status: res.status,
      url: current.toString(),
      headers: outHeaders,
      truncated: received > MAX_BYTES,
      body: new TextDecoder('utf-8', { fatal: false }).decode(merged)
    });
  } catch (err) {
    const aborted = err && err.name === 'AbortError';
    return json({
      status: 0,
      url: target.toString(),
      headers: {},
      body: '',
      error: aborted ? `Timed out after ${TIMEOUT_MS / 1000}s` : String(err?.message || err)
    });
  } finally {
    clearTimeout(timer);
  }
}
