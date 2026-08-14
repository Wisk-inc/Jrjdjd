/* POST /api/fetch — the sandbox's way onto the internet.

   Python running in the browser VM can only make same-origin requests, so
   `web.get(url)` comes here and this forwards it. That is what makes the
   terminal's network access real rather than CORS-limited.

   Guards: https/http only, no credentials forwarded, private and
   loopback addresses refused, response size capped. */

export const config = { runtime: 'edge' };

const MAX_BYTES = 2_000_000;
const TIMEOUT_MS = 20_000;

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
  });

/* Block anything that would let the sandbox poke at infrastructure rather
   than the public web. */
const isBlockedHost = (hostname) => {
  const h = hostname.toLowerCase();
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.internal')) return true;
  if (h === '::1' || h === '0.0.0.0') return true;
  if (/^127\./.test(h) || /^10\./.test(h) || /^192\.168\./.test(h)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true;
  if (/^169\.254\./.test(h)) return true;         // link-local / cloud metadata
  if (/^\[?fd[0-9a-f]{2}:/i.test(h)) return true; // unique local IPv6
  return false;
};

export default async function handler(request) {
  if (request.method !== 'POST') return json({ error: 'Use POST.' }, 405);

  let payload;
  try {
    payload = await request.json();
  } catch {
    return json({ error: 'Body must be JSON.' }, 400);
  }

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
    const res = await fetch(target.toString(), {
      method,
      headers,
      body: ['GET', 'HEAD'].includes(method) ? undefined : (payload.body ?? undefined),
      redirect: 'follow',
      signal: controller.signal
    });

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
      url: res.url || target.toString(),
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
