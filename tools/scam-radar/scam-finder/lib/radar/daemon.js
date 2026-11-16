// The scan loop. Every tick (a minute by default) it reads the newest certificates, picks
// the most suspicious names it hasn't visited, re-checks the sites that are due, and
// writes down whatever changed
//
// Everything is bounded: a fixed number of downloads and visits per tick, and a time limit
// that ends the tick cleanly. That is what lets it run forever on a small machine

import { MOBILE_UA, NetContext } from '../net.js';
import { Budget, loadPsl, mapLimit, sleep } from '../util.js';
import { checkSite, indicatorsOf, whyWatched } from './checker.js';
import { detectCohorts, markCohorts } from './cohorts.js';
import { ingestCt, ingestFeeds } from './ingest.js';

export const TICK_DEFAULTS = {
  seconds: 60,
  ct: true,
  ctTiles: 20,
  checks: 150,
  promote: 150,
  concurrency: 12,
  minScore: 55,
  rdap: 8,
  feedsEvery: 3600,
  cohortsEvery: 3600,
  userAgent: MOBILE_UA,
};

const seconds = () => Math.floor(Date.now() / 1000);

// Move the most suspicious unvisited names onto the watchlist
export const promote = (
  store,
  { limit = TICK_DEFAULTS.promote, minScore = TICK_DEFAULTS.minScore } = {},
) => {
  if (limit <= 0) return 0;
  const rows = store.candidates(limit, minScore);
  const added = store.addSites(rows.map((row) => ({ ...row, why: whyWatched(row) })));
  for (const row of rows)
    store.addEvent(row.name, 'watched', { why: whyWatched(row), triage: row.score });
  return added;
};

// Add sites to the watchlist by hand, whatever their triage score
export const watch = (store, names, why = 'added by hand') => {
  const stamp = seconds();
  const rows = names.map((name) => ({ name, why, src: 1024, seen: stamp }));
  store.upsertDomains(rows.map((row) => ({ name: row.name, src: 1024, seen: stamp })));
  return store.addSites(rows);
};

// Visit every site that is due, save what was learned, and log what changed
export const runChecks = async (store, ctx, options = {}) => {
  const settings = { ...TICK_DEFAULTS, ...options };
  const due = store.dueSites(settings.checks);
  const rdap = { left: settings.rdap };
  const results = [];
  await mapLimit(due, settings.concurrency, async (site) => {
    if (ctx.outOfTime(12000)) return;
    try {
      results.push(await checkSite(ctx, store, site, { userAgent: settings.userAgent, rdap }));
    } catch (error) {
      ctx.noteError('check', error);
    }
  });

  // If nearly everything "failed to answer" at once, the problem is our connection, not
  // a mass takedown: discard those results rather than record false outages
  const silent = results.filter(({ site }) => site.down_reason === 'The server did not answer');
  const outage = results.length >= 20 && silent.length / results.length >= 0.9;
  const report = { due: due.length, checked: 0, live: 0, down: 0, events: 0, takedowns: 0, outage };
  for (const { site, events } of results) {
    if (outage && silent.some((item) => item.site === site)) continue;
    store.saveSite(site);
    store.setIndicators(site.name, indicatorsOf(site));
    for (const event of events) store.addEvent(site.name, event.type, event.detail);
    report.checked += 1;
    report.events += events.length;
    report.takedowns += events.filter((event) => event.type === 'taken-down').length;
    if (site.state === 'live') report.live += 1;
    else report.down += 1;
  }
  return report;
};

// One full cycle. Safe to call from a scheduler instead of running the loop
export const tick = async (store, options = {}) => {
  const settings = { ...TICK_DEFAULTS, ...options };
  const started = Date.now();
  await loadPsl();
  const ctx =
    options.ctx ||
    new NetContext({
      budget: new Budget(Math.max(10, settings.seconds - 4) * 1000),
      cacheDir: false,
    });
  const log = settings.log || (() => {});
  const report = { at: new Date().toISOString() };
  const stamp = seconds();

  if (settings.feedsEvery && stamp - store.getMeta('feeds:at', 0) >= settings.feedsEvery) {
    report.feeds = (await ingestFeeds(store, ctx, { feeds: 'light', log })).names;
    store.setMeta('feeds:at', stamp);
  }
  if (settings.ct && !ctx.outOfTime(20000)) {
    const result = await ingestCt(store, ctx, {
      tiles: settings.ctTiles,
      backfill: settings.ctTiles,
      log,
    });
    report.certificates = {
      tiles: result.tiles,
      hostnames: result.hostnames,
      newDomains: result.fresh,
    };
  }
  if (settings.cohortsEvery && stamp - store.getMeta('cohorts:at', 0) >= settings.cohortsEvery) {
    const marked = markCohorts(store, detectCohorts(store));
    store.setMeta('cohorts:at', stamp);
    report.batches = marked.length;
    log(`Bulk-registration batches: ${marked.length} moulds flagged`);
  }
  report.promoted = promote(store, { limit: settings.promote, minScore: settings.minScore });
  report.checks = await runChecks(store, ctx, settings);
  report.errors = ctx.errors.slice(0, 5);
  report.requests = ctx.stats.requests;
  report.seconds = Number(((Date.now() - started) / 1000).toFixed(1));
  const ticks = store.getMeta('ticks', 0) + 1;
  store.setMeta('lastTick', report);
  store.setMeta('ticks', ticks);
  // The head-count of 16M+ rows is cached; recount now and then rather than every minute
  if (report.batches !== undefined || ticks % 30 === 0) store.stats({ refresh: true });
  return report;
};

// Run ticks back to back, each starting on schedule, until told to stop
export const run = async (store, options = {}) => {
  const settings = { ...TICK_DEFAULTS, ...options };
  let remaining = settings.ticks ?? Infinity;
  let stopping = false;
  const stop = () => {
    stopping = true;
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    while (remaining > 0 && !stopping) {
      const started = Date.now();
      const report = await tick(store, settings);
      settings.onTick?.(report);
      remaining -= 1;
      const rest = settings.seconds * 1000 - (Date.now() - started);
      if (remaining > 0 && !stopping && rest > 0) await sleep(rest);
    }
  } finally {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
  }
};
