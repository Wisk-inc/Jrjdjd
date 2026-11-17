// Scam Finder as an API for the Scam Radar pages. One function, wrapped per host:
//   GET /api/scam-finder?url=<link or domain>            profile the link, score it (about 5 seconds)
//   GET /api/scam-finder?url=<link or domain>&depth=1    also search for sites sharing its fingerprints
//   GET /api/scam-finder?url=<link or domain>&depth=2    the deep dive: more time, more pivots, more
//                                                         related sites profiled (up to about 40 seconds)
//   GET /api/scam-finder?contact=<email or phone number> what the address or number says about itself,
//                                                         and whether spam-report services know it
//   GET /api/scam-finder?ping=1                          is the API here?
//
// It runs Scam Finder's own investigate(), with small limits so it answers inside a serverless
// request, then passes the result through sanitize.mjs before it leaves.
//
// Guards: GET only, http and https only, private and local addresses refused here, at every redirect
// hop and at every connection (guarded-request.mjs), one page plus a few of its files fetched
// with size caps, a time budget, input limits and per-address rate limits. Nothing is stored.
import { describeContact } from './scam-finder/lib/contacts.js';
import { toGraph } from './scam-finder/lib/graph.js';
import { investigate } from './scam-finder/lib/investigate.js';
import { NetContext } from './scam-finder/lib/net.js';
import { Budget, isLocalName, parseTarget } from './scam-finder/lib/util.js';
import { makeGuardedRequest, privateAddress } from './guarded-request.mjs';
import { clean, cleanTitle, sanitizeCampaigns, sanitizeDomain, sanitizeLinks } from './sanitize.mjs';

export const API_VERSION = 1;
// Seven seconds of work fits a ten-second serverless limit with room for a cold start. A host that
// allows longer can raise it with SCAM_FINDER_BUDGET_MS (up to 60 seconds) for deeper results.
const budgetMs = () => Math.min(60000, Math.max(5000, Number(process.env.SCAM_FINDER_BUDGET_MS) || 7000));
// The deep dive needs a host that lets a function run for a minute (vercel.json sets 60 seconds)
const deepBudgetMs = () => Math.min(55000, Math.max(10000, Number(process.env.SCAM_FINDER_DEEP_BUDGET_MS) || 40000));
const OPTIONS = {
  0: () => ({ depth: 0, feeds: 'light', timeBudgetMs: budgetMs(), cacheDir: undefined }),
  1: () => ({ quick: true, depth: 1, maxPivots: 4, pages: 4, rdap: 4, maxDomains: 80, feeds: 'light', timeBudgetMs: budgetMs() }),
  2: () => ({ depth: 1, maxPivots: 10, pages: 10, rdap: 12, maxDomains: 200, maxResultsPerPivot: 200, feeds: 'default',
    timeBudgetMs: deepBudgetMs() }),
};

// ---- Every request Scam Finder makes for this API goes through guarded-request.mjs: the address of
// each request and of each redirect hop is checked, and the connection goes to the checked address.
// Scam Finder checks the pages it visits itself; this also covers the files it downloads from a page,
// which it fetches with automatic redirects, and a name that would give one address to a check and
// another to the connection (DNS rebinding). Nothing outside Scam Finder's requests is touched.
const guardedRequest = makeGuardedRequest();

// A small per-address limit. It lives in one instance's memory, so it slows a script down
// without pretending to be a wall.
// A deep dive asks many outside services for one link, so it gets its own, tighter limit.
const LIMITS = {
  check: { windowMs: 60 * 1000, perAddress: 8, perInstance: 40, recent: new Map() },
  deep: { windowMs: 10 * 60 * 1000, perAddress: 3, perInstance: 20, recent: new Map() },
};
const allow = (address, kind = 'check', now = Date.now()) => {
  const { windowMs, perAddress, perInstance, recent } = LIMITS[kind];
  let total = 0;
  for (const [key, times] of recent) {
    const kept = times.filter((time) => now - time < windowMs);
    if (kept.length) recent.set(key, kept); else recent.delete(key);
    total += kept.length;
  }
  const mine = recent.get(address) || [];
  if (mine.length >= perAddress || total >= perInstance) return false;
  recent.set(address, [...mine, now]);
  return true;
};

const reply = (status, body, cache = 'no-store') => ({
  status,
  headers: {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': cache,
    'x-content-type-options': 'nosniff',
    'x-robots-tag': 'noindex',
    'cross-origin-resource-policy': 'same-origin',
    'referrer-policy': 'no-referrer',
  },
  body,
});

// The result, made safe to show: see sanitize.mjs for what is kept and what is dropped
const tidy = (result) => {
  for (const domain of result.domains || []) {
    sanitizeDomain(domain);
    // DNS text records can hold other services' verification tokens: keep what they say about
    // mail, drop the values
    if (domain.dns) {
      const txt = Array.isArray(domain.dns.txt) ? domain.dns.txt : [];
      domain.dns = { ...domain.dns, txt: undefined, spf: txt.some((t) => /^"?v=spf1/i.test(String(t))) };
    }
  }
  sanitizeCampaigns(result.campaigns);
  sanitizeLinks(result.links);
  result.pivots = (result.pivots || []).map(({ type, why, status, total, windowDays, depth }) =>
    ({ type, why: type === 'title' ? cleanTitle(why) || 'Same page title' : clean(why, 140), status, total, windowDays, depth }));
  if (result.sources) {
    result.sources.errors = (result.sources.errors || []).slice(0, 8)
      .map(({ source, message }) => ({ source: clean(source, 40), message: clean(message, 160) }));
  }
  result.graph = toGraph(result);
  return result;
};

/**
 * @param {{ method?: string, query: Record<string, string | undefined>, address?: string }} request
 * @param {{ run?: typeof investigate, describe?: typeof describeContact, request?: Function }} [deps] swapped in tests
 */
const tooMany = (wait) => {
  const base = reply(429, { error: `Too many checks from this address. Wait ${wait} and try again.` });
  return { ...base, headers: { ...base.headers, 'retry-after': wait === 'a minute' ? '60' : '600' } };
};

// An email address or phone number from a scam message: what it says about itself (provider, a
// throwaway mailbox, the number's country and any regulator warning on its range) and whether
// spam-report services know it. Breach exposure needs the host's own Have I Been Pwned key.
// Nothing here looks the person up anywhere else.
const checkContact = async (value, address, deps) => {
  if (value.length > 200) return reply(400, { error: 'That is too long to be an email address or a phone number' });
  if (!allow(String(address))) return tooMany('a minute');
  const ctx = new NetContext({ budget: new Budget(10000), cacheDir: false, request: deps.request || guardedRequest });
  try {
    const result = await (deps.describe || describeContact)(ctx, value, { online: true });
    if (!result) return reply(400, { error: 'Give an email address, or a phone number with its country code' });
    return reply(200, { api: API_VERSION, kind: 'contact', ...result }, 'private, max-age=300');
  } catch (error) {
    return reply(502, { error: `The check could not be finished: ${clean(error.message, 160)}` });
  }
};

export const handle = async ({ method = 'GET', query = {}, address = 'unknown' }, deps = {}) => {
  if (method !== 'GET' && method !== 'HEAD') return reply(405, { error: 'Only GET is supported' });
  if (query.ping !== undefined) {
    return reply(200, { ok: true, tool: 'scam-finder', api: API_VERSION, depths: [0, 1, 2], contact: true, budgetMs: budgetMs(),
      deepBudgetMs: deepBudgetMs() }, 'public, max-age=300, s-maxage=3600');
  }
  // Nothing typed into a form has control characters in it
  const raw = String(query.contact ?? query.url ?? '');
  if (/[\u0000-\u001f\u007f]/.test(raw)) return reply(400, { error: 'That has characters a link or an address never has' });
  if (query.contact !== undefined) return checkContact(raw.trim(), address, deps);

  const input = raw.trim();
  if (!input) return reply(400, { error: 'Give a link or a domain: /api/scam-finder?url=example.com' });
  if (input.length > 2048) return reply(400, { error: 'That link is too long' });
  let target;
  try {
    target = parseTarget(input);
  } catch (error) {
    return reply(400, { error: clean(error.message, 160) });
  }
  if (isLocalName(target.host) || (target.isIp && privateAddress(target.host))) {
    return reply(400, { error: 'That address is private or local, so there is nothing public to check' });
  }
  const depth = String(query.depth) === '2' ? 2 : String(query.depth) === '1' ? 1 : 0;
  if (depth === 2 && !allow(String(address), 'deep')) return tooMany('ten minutes');
  if (depth < 2 && !allow(String(address))) return tooMany('a minute');

  try {
    const options = OPTIONS[depth]();
    const ctx = new NetContext({ budget: new Budget(options.timeBudgetMs), cacheDir: options.cacheDir, request: deps.request || guardedRequest });
    const result = await (deps.run || investigate)(target.url, { ...options, ctx });
    tidy(result);
    return reply(200, { api: API_VERSION, depth, ...result }, 'public, max-age=120, s-maxage=600');
  } catch (error) {
    return reply(502, { error: `The check could not be finished: ${clean(error.message, 160)}` });
  }
};
