// Network plumbing: size-capped fetches, polite per-host rate limits and an on-disk cache
// Every lookup the engine makes goes through here, so one place owns timeouts and manners

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { sha1, sleep } from './util.js';

// A generic identity for the public APIs we query, overridable for people who want their own
export const TOOL_UA = process.env.SCAM_FINDER_UA || 'scam-finder/1.0 (OSINT research tool)';

// What suspect pages see: an ordinary phone, since many scam kits hide from desktops and bots
export const MOBILE_UA =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/130.0.0.0 Mobile Safari/537.36';

export const DESKTOP_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/130.0.0.0 Safari/537.36';

const DEFAULT_TIMEOUT = 15000;
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;

// Read a response body, but stop once it passes the cap (suspect servers can send anything)
const readCapped = async (response, maxBytes) => {
  if (!response.body) return { bytes: Buffer.alloc(0), truncated: false };
  const chunks = [];
  let total = 0;
  let truncated = false;
  const reader = response.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        chunks.push(Buffer.from(value.subarray(0, value.byteLength - (total - maxBytes))));
        truncated = true;
        break;
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    if (truncated) await reader.cancel().catch(() => {});
  }
  return { bytes: Buffer.concat(chunks), truncated };
};

// Turn fetch's assorted failures into one error shape with a short, stable code
const wrapError = (error, url) => {
  const code =
    error.name === 'TimeoutError' || error.name === 'AbortError'
      ? 'TIMEOUT'
      : error.cause?.code || error.code || 'NETWORK';
  const wrapped = new Error(`${code} fetching ${new URL(url).host}: ${error.message}`);
  wrapped.code = code;
  return wrapped;
};

// One HTTP request with a timeout and a body cap, returning text and parsed headers
export const request = async (url, opts = {}) => {
  const headers = { 'user-agent': TOOL_UA, accept: '*/*' };
  for (const [name, value] of Object.entries(opts.headers || {})) {
    headers[name.toLowerCase()] = value;
  }
  const init = {
    method: opts.method || 'GET',
    headers,
    redirect: opts.redirect || 'follow',
    signal: AbortSignal.timeout(opts.timeoutMs || DEFAULT_TIMEOUT),
  };
  if (opts.body !== undefined) {
    init.body = typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body);
    if (typeof opts.body !== 'string') headers['content-type'] ??= 'application/json';
  }

  let response;
  let body;
  try {
    response = await fetch(url, init);
    body = await readCapped(response, opts.maxBytes || DEFAULT_MAX_BYTES);
  } catch (error) {
    throw wrapError(error, url);
  }

  const responseHeaders = {};
  for (const [name, value] of response.headers.entries()) responseHeaders[name] = value;
  return {
    status: response.status,
    ok: response.status >= 200 && response.status < 300,
    url: response.url || url,
    headers: responseHeaders,
    bytes: body.bytes,
    truncated: body.truncated,
    get text() {
      return new TextDecoder('utf-8', { fatal: false }).decode(body.bytes);
    },
    json() {
      return JSON.parse(new TextDecoder('utf-8').decode(body.bytes));
    },
  };
};

// Open a download as a stream of bytes, for files far too large to hold in memory
export const openStream = async (url, opts = {}) => {
  const headers = { 'user-agent': TOOL_UA, accept: '*/*' };
  for (const [name, value] of Object.entries(opts.headers || {}))
    headers[name.toLowerCase()] = value;
  let response;
  try {
    response = await fetch(url, { headers, redirect: 'follow', signal: opts.signal });
  } catch (error) {
    throw wrapError(error, url);
  }
  if (!response.ok || !response.body) {
    const error = new Error(`HTTP ${response.status} from ${new URL(url).host}`);
    error.status = response.status;
    throw error;
  }
  const stream = Readable.fromWeb(response.body);
  stream.headers = Object.fromEntries(response.headers.entries());
  return stream;
};

// How hard we're allowed to lean on each service; anything unlisted gets the default
const HOST_RULES = {
  'urlscan.io': { concurrency: 1, minIntervalMs: 2100 },
  'api.certspotter.com': { concurrency: 1, minIntervalMs: 1500 },
  'crt.sh': { concurrency: 1, minIntervalMs: 1500 },
  'ip.thc.org': { concurrency: 1, minIntervalMs: 800 },
  'api.hackertarget.com': { concurrency: 1, minIntervalMs: 1200 },
  'rdap.org': { concurrency: 1, minIntervalMs: 700 },
  'dns.google': { concurrency: 8, minIntervalMs: 0 },
  'cloudflare-dns.com': { concurrency: 8, minIntervalMs: 0 },
  'raw.githubusercontent.com': { concurrency: 3, minIntervalMs: 0 },
  'data.commoncrawl.org': { concurrency: 1, minIntervalMs: 500 },
  'mon.sycamore.ct.letsencrypt.org': { concurrency: 4, minIntervalMs: 0 },
  'mon.willow.ct.letsencrypt.org': { concurrency: 4, minIntervalMs: 0 },
  'storage.googleapis.com': { concurrency: 4, minIntervalMs: 0 },
  'tuscolo2027h1.skylight.geomys.org': { concurrency: 1, minIntervalMs: 400 },
  'ipwho.is': { concurrency: 1, minIntervalMs: 1100 },
  'haveibeenpwned.com': { concurrency: 1, minIntervalMs: 6500 },
  'api.stopforumspam.org': { concurrency: 1, minIntervalMs: 1000 },
};
const DEFAULT_RULE = { concurrency: 3, minIntervalMs: 150 };

// Queues requests per host, spacing them out and capping how many are in flight
export class HostLimiter {
  constructor(rules = {}) {
    this.rules = { ...HOST_RULES, ...rules };
    this.state = new Map();
  }

  ruleFor(host) {
    return this.rules[host] || DEFAULT_RULE;
  }

  async run(url, task) {
    const host = new URL(url).host;
    const rule = this.ruleFor(host);
    let slot = this.state.get(host);
    if (!slot) {
      slot = { active: 0, queue: [], nextAt: 0 };
      this.state.set(host, slot);
    }
    if (slot.active >= rule.concurrency) {
      // A finishing request hands its place straight to us, so the count stays put
      await new Promise((resolve) => slot.queue.push(resolve));
    } else {
      slot.active += 1;
    }
    try {
      const wait = slot.nextAt - Date.now();
      slot.nextAt = Math.max(Date.now(), slot.nextAt) + rule.minIntervalMs;
      if (wait > 0) await sleep(wait);
      return await task();
    } finally {
      const next = slot.queue.shift();
      if (next) next();
      else slot.active -= 1;
    }
  }

  // Push a host's next allowed request into the future, after it tells us to back off
  pause(url, ms) {
    const host = new URL(url).host;
    const slot = this.state.get(host);
    if (slot) slot.nextAt = Math.max(slot.nextAt, Date.now() + ms);
  }
}

// A tiny file cache, so repeat runs are fast and free services aren't asked twice
export class DiskCache {
  constructor(dir) {
    this.dir = dir === false ? null : dir || DiskCache.defaultDir();
    this.ready = false;
  }

  static defaultDir() {
    if (process.env.SCAM_FINDER_NO_CACHE) return null;
    return process.env.SCAM_FINDER_CACHE_DIR || path.join(os.tmpdir(), 'scam-finder-cache');
  }

  file(key) {
    return path.join(this.dir, `${sha1(key)}.cache`);
  }

  prepare() {
    if (this.ready || !this.dir) return;
    fs.mkdirSync(this.dir, { recursive: true });
    this.ready = true;
  }

  // The cached text for a key, or null when it's missing, stale or unreadable
  get(key, ttlMs) {
    if (!this.dir) return null;
    try {
      const file = this.file(key);
      if (Date.now() - fs.statSync(file).mtimeMs > ttlMs) return null;
      return fs.readFileSync(file, 'utf8');
    } catch {
      return null;
    }
  }

  // Best effort: a read-only disk (serverless) just means nothing is cached
  set(key, text) {
    if (!this.dir) return;
    try {
      this.prepare();
      fs.writeFileSync(this.file(key), text);
    } catch {
      this.dir = null;
    }
  }
}

const MINUTE = 60 * 1000;
export const TTL = {
  dns: 30 * MINUTE,
  search: 30 * MINUTE,
  rdap: 12 * 60 * MINUTE,
  feed: 6 * 60 * MINUTE,
  static: 7 * 24 * 60 * MINUTE,
};

// Shared state for one investigation: limiter, cache, time budget and a log of what failed
export class NetContext {
  constructor(opts = {}) {
    this.limiter = opts.limiter || new HostLimiter();
    this.cache = opts.cache || new DiskCache(opts.cacheDir);
    this.budget = opts.budget || null;
    this.errors = [];
    this.stats = { requests: 0, cacheHits: 0 };
    this.fetchImpl = opts.request || request;
    this.streamImpl = opts.stream || openStream;
  }

  // A rate-limited streaming download (the limiter only spaces out the opening request)
  async stream(url, opts = {}) {
    return this.limiter.run(url, () => {
      this.stats.requests += 1;
      return this.streamImpl(url, opts);
    });
  }

  // Record a source failure once per source, so reports can say what was unavailable
  noteError(source, error) {
    const message = typeof error === 'string' ? error : error?.message || String(error);
    if (!this.errors.some((entry) => entry.source === source && entry.message === message)) {
      this.errors.push({ source, message });
    }
  }

  outOfTime(reserveMs = 0) {
    return this.budget ? this.budget.expired(reserveMs) : false;
  }

  // Rate-limited request, never started once the time budget has run out
  async fetch(url, opts = {}) {
    if (this.outOfTime(opts.reserveMs || 0)) {
      const error = new Error('Time budget exhausted');
      error.code = 'BUDGET';
      throw error;
    }
    const timeoutMs = this.budget
      ? Math.max(1000, Math.min(opts.timeoutMs || DEFAULT_TIMEOUT, this.budget.left()))
      : opts.timeoutMs;
    return this.limiter.run(url, () => {
      this.stats.requests += 1;
      return this.fetchImpl(url, { ...opts, timeoutMs });
    });
  }

  // GET some text with caching; only successful responses are stored
  async cachedText(url, opts = {}) {
    const key =
      opts.cacheKey ||
      `${opts.method || 'GET'} ${url} ${opts.body ? sha1(JSON.stringify(opts.body)) : ''}`;
    const ttl = opts.ttl ?? TTL.search;
    const hit = ttl > 0 ? this.cache.get(key, ttl) : null;
    if (hit !== null) {
      this.stats.cacheHits += 1;
      return { status: 200, ok: true, text: hit, cached: true, headers: {} };
    }
    const response = await this.fetch(url, opts);
    const text = response.text;
    if (response.ok && ttl > 0 && !response.truncated) this.cache.set(key, text);
    return {
      status: response.status,
      ok: response.ok,
      text,
      cached: false,
      headers: response.headers,
    };
  }

  // Same, parsed as JSON; throws an error carrying the HTTP status when it isn't a 2xx
  async cachedJson(url, opts = {}) {
    const response = await this.cachedText(url, opts);
    if (!response.ok) {
      const error = new Error(`HTTP ${response.status} from ${new URL(url).host}`);
      error.status = response.status;
      error.headers = response.headers;
      error.body = response.text.slice(0, 300);
      throw error;
    }
    try {
      return JSON.parse(response.text);
    } catch {
      throw new Error(`Unexpected non-JSON reply from ${new URL(url).host}`);
    }
  }
}
