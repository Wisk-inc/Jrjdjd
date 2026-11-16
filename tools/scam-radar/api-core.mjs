// Scam Finder as an API for the Scam Radar pages. One function, wrapped per host:
//   GET /api/scam-finder?url=<link or domain>            profile the link, score it (about 5 seconds)
//   GET /api/scam-finder?url=<link or domain>&depth=1    also search for sites sharing its fingerprints
//   GET /api/scam-finder?ping=1                          is the API here?
//
// It runs Scam Finder's own investigate(), with small limits so it answers inside a serverless
// request, then passes the result through sanitize.mjs before it leaves.
//
// Guards: GET only, http and https only, private and local addresses refused here and again at
// every hop inside Scam Finder, one page plus a few of its files fetched with size caps, a time
// budget, and a per-address rate limit. Nothing is stored.
import { toGraph } from './scam-finder/lib/graph.js';
import { investigate } from './scam-finder/lib/investigate.js';
import { isLocalName, isPrivateIp, parseTarget } from './scam-finder/lib/util.js';
import { clean, cleanTitle, sanitizeCampaigns, sanitizeDomain, sanitizeLinks } from './sanitize.mjs';

export const API_VERSION = 1;
// Seven seconds of work fits a ten-second serverless limit with room for a cold start. A host that
// allows longer can raise it with SCAM_FINDER_BUDGET_MS (up to 60 seconds) for deeper results.
const budgetMs = () => Math.min(60000, Math.max(5000, Number(process.env.SCAM_FINDER_BUDGET_MS) || 7000));
const OPTIONS = {
  0: () => ({ depth: 0, feeds: 'light', timeBudgetMs: budgetMs(), cacheDir: undefined }),
  1: () => ({ quick: true, depth: 1, maxPivots: 4, pages: 4, rdap: 4, maxDomains: 80, feeds: 'light', timeBudgetMs: budgetMs() }),
};

// A small per-address limit. It lives in one instance's memory, so it slows a script down
// without pretending to be a wall.
const WINDOW_MS = 60 * 1000;
const PER_ADDRESS = 8;
const PER_INSTANCE = 40;
const recent = new Map();
const allow = (address, now = Date.now()) => {
  let total = 0;
  for (const [key, times] of recent) {
    const kept = times.filter((time) => now - time < WINDOW_MS);
    if (kept.length) recent.set(key, kept); else recent.delete(key);
    total += kept.length;
  }
  const mine = recent.get(address) || [];
  if (mine.length >= PER_ADDRESS || total >= PER_INSTANCE) return false;
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
  },
  body,
});

// The result, made safe to show: see sanitize.mjs for what is kept and what is dropped
const tidy = (result) => {
  for (const domain of result.domains || []) sanitizeDomain(domain);
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
 * @param {{ run?: typeof investigate }} [deps] swapped in tests
 */
export const handle = async ({ method = 'GET', query = {}, address = 'unknown' }, deps = {}) => {
  if (method !== 'GET' && method !== 'HEAD') return reply(405, { error: 'Only GET is supported' });
  if (query.ping !== undefined) {
    return reply(200, { ok: true, tool: 'scam-finder', api: API_VERSION, depths: [0, 1], budgetMs: budgetMs() },
      'public, max-age=300, s-maxage=3600');
  }

  const input = String(query.url || '').trim();
  if (!input) return reply(400, { error: 'Give a link or a domain: /api/scam-finder?url=example.com' });
  if (input.length > 2048) return reply(400, { error: 'That link is too long' });
  let target;
  try {
    target = parseTarget(input);
  } catch (error) {
    return reply(400, { error: clean(error.message, 160) });
  }
  if (isLocalName(target.host) || (target.isIp && isPrivateIp(target.host))) {
    return reply(400, { error: 'That address is private or local, so there is nothing public to check' });
  }
  const depth = String(query.depth) === '1' ? 1 : 0;
  if (!allow(String(address))) {
    return { ...reply(429, { error: 'Too many checks from this address. Wait a minute and try again.' }), headers: { ...reply(429, {}).headers, 'retry-after': '60' } };
  }

  try {
    const result = await (deps.run || investigate)(target.url, OPTIONS[depth]());
    tidy(result);
    return reply(200, { api: API_VERSION, depth, ...result }, 'public, max-age=120, s-maxage=600');
  } catch (error) {
    return reply(502, { error: `The check could not be finished: ${clean(error.message, 160)}` });
  }
};
