// The scan API's requests to the internet, each checked before it connects. It is handed to Scam
// Finder's NetContext as its `request`, so it covers what Scam Finder fetches for the API and nothing
// else in the process: on a serverless host the platform's own code shares the process and talks to
// local addresses, so dns.lookup and the global fetch are left alone.
//
// For every request and every redirect hop:
// - only http and https, and never a local name or a private, loopback or link-local address;
// - the name is looked up once, every address it gives is checked, and the connection goes to the
//   checked address, so a name cannot give one address to the check and another to the connection
//   (DNS rebinding);
// - redirects are followed here, hop by hop, unless the caller asks for them by hand;
// - the body is capped (2 MB unless the caller asks for less) and so is the time.
//
// It returns what Scam Finder's own request() in net.js returns, and fails the same way: an error with
// a short code (BLOCKED, TIMEOUT, ENOTFOUND, ...) and a message naming the host.
import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import zlib from 'node:zlib';
import { TOOL_UA } from './scam-finder/lib/net.js';
import { isIp, isLocalName, isPrivateIp } from './scam-finder/lib/util.js';

const DEFAULT_TIMEOUT = 15000;
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
const MAX_HOPS = 6;

// An IPv6 address as eight numbers, or null when it is not one
const v6Groups = (ip) => {
  let text = String(ip).toLowerCase().replace(/^\[|\]$/g, '').split('%')[0];
  const tail = text.match(/(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (tail) {
    const [a, b, c, d] = tail.slice(1).map(Number);
    text = `${text.slice(0, tail.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head, rest, extra] = text.split('::');
  if (extra !== undefined) return null;
  const front = head ? head.split(':') : [];
  const back = rest === undefined ? null : rest ? rest.split(':') : [];
  const groups = back === null ? front : [...front, ...Array(Math.max(0, 8 - front.length - back.length)).fill('0'), ...back];
  return groups.length === 8 && groups.every((g) => /^[0-9a-f]{1,4}$/.test(g)) ? groups.map((g) => parseInt(g, 16)) : null;
};

// Private, loopback, link-local and the like. An IPv6 address that carries an IPv4 one (::ffff:7f00:1
// is 127.0.0.1) is judged by the IPv4 address inside, and the two ranges that translate to IPv4
// (64:ff9b::/96 and 2002::/16) are refused outright.
export const privateAddress = (ip) => {
  if (isPrivateIp(ip)) return true;
  const text = String(ip || '').replace(/^\[|\]$/g, '');
  if (!net.isIPv6(text)) return false;
  if (/^(64:ff9b:|2002:)/i.test(text)) return true;
  const g = v6Groups(text);
  if (!g) return true;
  const zeros = (n) => g.slice(0, n).every((x) => x === 0);
  const inside = `${g[6] >> 8}.${g[6] & 255}.${g[7] >> 8}.${g[7] & 255}`;
  if ((zeros(5) && (g[5] === 0 || g[5] === 0xffff)) || (zeros(4) && g[4] === 0xffff && g[5] === 0)) return isPrivateIp(inside);
  return false;
};

const failure = (code, host, message) => Object.assign(new Error(`${code} fetching ${host}: ${message}`), { code });

/**
 * @param {{ blockedAddress?: (ip: string) => boolean, resolve?: (host: string) => Promise<{address: string, family: number}[]> }} [options]
 *   swapped in tests only
 */
export const makeGuardedRequest = ({ blockedAddress = privateAddress, resolve } = {}) => {
  const lookupAll = resolve || ((host) => dns.promises.lookup(host, { all: true, verbatim: true }));

  // Where one hop may connect: every address the name has must be public
  const addressFor = async (url) => {
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw failure('BLOCKED', url.protocol, 'not a web address');
    const host = url.hostname.replace(/^\[|\]$/g, '');
    if (isLocalName(host)) throw failure('BLOCKED', host, 'local hostname');
    if (isIp(host)) {
      if (blockedAddress(host)) throw failure('BLOCKED', host, 'private address');
      return { address: host, family: host.includes(':') ? 6 : 4 };
    }
    let list;
    try {
      list = await lookupAll(host);
    } catch (error) {
      throw failure(error.code || 'ENOTFOUND', host, 'does not resolve');
    }
    if (!list.length) throw failure('ENOTFOUND', host, 'does not resolve');
    if (list.some((entry) => blockedAddress(entry.address))) throw failure('BLOCKED', host, 'resolves to a private address');
    return list[0];
  };

  // One request to one checked address; resolves with the status, headers and capped body
  const once = (url, pinned, opts, deadline) => new Promise((resolve, reject) => {
    const host = url.hostname.replace(/^\[|\]$/g, '');
    const headers = { 'user-agent': TOOL_UA, accept: '*/*', 'accept-encoding': 'gzip, deflate, br' };
    for (const [name, value] of Object.entries(opts.headers || {})) headers[name.toLowerCase()] = value;
    let body;
    if (opts.body !== undefined) {
      body = typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body);
      if (typeof opts.body !== 'string') headers['content-type'] ??= 'application/json';
      headers['content-length'] = Buffer.byteLength(body);
    }
    const left = deadline - Date.now();
    if (left <= 0) return reject(failure('TIMEOUT', host, 'timed out'));
    const client = url.protocol === 'https:' ? https : http;
    const request = client.request({
      protocol: url.protocol,
      hostname: host,
      port: url.port || undefined,
      path: `${url.pathname}${url.search}`,
      method: opts.method || 'GET',
      headers,
      servername: isIp(host) ? undefined : host,
      // The connection goes to the address that was checked, never to a second lookup
      lookup: (_name, options, callback) => (options && options.all
        ? callback(null, [{ address: pinned.address, family: pinned.family }])
        : callback(null, pinned.address, pinned.family)),
      agent: false,
    });
    const timer = setTimeout(() => request.destroy(failure('TIMEOUT', host, 'timed out')), left);
    const onAbort = () => request.destroy(failure('TIMEOUT', host, 'aborted'));
    opts.signal?.addEventListener?.('abort', onAbort, { once: true });
    const finish = (fn, value) => {
      clearTimeout(timer);
      opts.signal?.removeEventListener?.('abort', onAbort);
      fn(value);
    };
    request.on('error', (error) => finish(reject, error.code && error.message.includes('fetching') ? error
      : failure(error.code || 'NETWORK', host, error.message)));
    request.on('response', (response) => {
      // A redirect, an empty answer or a HEAD has no body worth decoding (and an empty one would not decode)
      const status = response.statusCode;
      const bare = (status >= 300 && status < 400) || status === 204 || String(opts.method || 'GET').toUpperCase() === 'HEAD';
      const encoding = bare ? '' : String(response.headers['content-encoding'] || '').toLowerCase().trim();
      let stream = response;
      if (encoding === 'gzip' || encoding === 'x-gzip') stream = response.pipe(zlib.createGunzip());
      else if (encoding === 'deflate') stream = response.pipe(zlib.createInflate());
      else if (encoding === 'br') stream = response.pipe(zlib.createBrotliDecompress());
      const max = opts.maxBytes || DEFAULT_MAX_BYTES;
      const chunks = [];
      let total = 0;
      let truncated = false;
      const done = () => finish(resolve, { status: response.statusCode, headers: response.headers, bytes: Buffer.concat(chunks), truncated });
      stream.on('data', (chunk) => {
        if (truncated) return;
        const room = max - total;
        if (chunk.length >= room) {
          chunks.push(chunk.subarray(0, room));
          total = max;
          truncated = true;
          response.destroy();
          done();
          return;
        }
        chunks.push(chunk);
        total += chunk.length;
      });
      stream.on('end', () => { if (!truncated) done(); });
      stream.on('error', (error) => { if (!truncated) finish(reject, failure(error.code || 'NETWORK', host, error.message)); });
    });
    if (body !== undefined) request.write(body);
    request.end();
  });

  return async (rawUrl, opts = {}) => {
    const deadline = Date.now() + (opts.timeoutMs || DEFAULT_TIMEOUT);
    const follow = (opts.redirect || 'follow') === 'follow';
    let url = new URL(rawUrl);
    let options = { ...opts };
    for (let hop = 0; hop <= MAX_HOPS; hop += 1) {
      const pinned = await addressFor(url);
      const answer = await once(url, pinned, options, deadline);
      const location = answer.headers.location;
      if (follow && answer.status >= 300 && answer.status < 400 && location) {
        url = new URL(location, url);
        // As browsers do: a 303, or a 301 or 302 after a POST, continues as a GET without a body
        const method = String(options.method || 'GET').toUpperCase();
        if (answer.status === 303 || ((answer.status === 301 || answer.status === 302) && method === 'POST')) {
          options = { ...options, method: 'GET', body: undefined };
        }
        continue;
      }
      const headers = {};
      for (const [name, value] of Object.entries(answer.headers)) headers[name] = Array.isArray(value) ? value.join(', ') : value;
      const { bytes } = answer;
      return {
        status: answer.status,
        ok: answer.status >= 200 && answer.status < 300,
        url: url.href,
        headers,
        bytes,
        truncated: answer.truncated,
        get text() {
          return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
        },
        json() {
          return JSON.parse(new TextDecoder('utf-8').decode(bytes));
        },
      };
    }
    throw failure('REDIRECTS', url.hostname, `more than ${MAX_HOPS} redirects`);
  };
};
