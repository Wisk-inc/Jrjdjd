// Bulk sources of domain names. Each one streams straight into the database, scoring every
// name on the way in, so memory use stays flat however large the source is

import { TTL } from '../net.js';
import { FEEDS, parseFeed, resolveFeeds } from '../sources/feeds.js';
import { cleanHost, registrableDomain } from '../util.js';
import { gunzipStream, lineBatches, unzipFirst } from './bulk.js';
import { activeLogs, readLog } from './ct.js';
import { SRC } from './store.js';
import { looksRandom, nameScore, shapeOf } from './triage.js';

const BATCH = 20000;
const DOMAIN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;
const FEED_BITS = {
  phishing: SRC.PHISHING,
  scam: SRC.SCAM,
  crypto: SRC.CRYPTO,
  threat: SRC.THREAT,
};
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

const seconds = () => Math.floor(Date.now() / 1000);

// Collects rows and name-shape tallies, flushing to the database every BATCH rows
class Loader {
  constructor(store, { baseline = false } = {}) {
    this.store = store;
    this.baseline = baseline;
    this.rows = [];
    this.shapes = new Map();
    this.total = 0;
  }

  tally(domain, field) {
    const shape = shapeOf(domain);
    if (!shape) return;
    let entry = this.shapes.get(shape);
    if (!entry) {
      entry = { base: 0, fresh: 0, random: 0 };
      this.shapes.set(shape, entry);
    }
    entry[field] += 1;
    if (field === 'fresh' && looksRandom(domain.slice(0, domain.indexOf('.')))) entry.random += 1;
  }

  add(row) {
    this.rows.push(row);
    if (this.baseline) this.tally(row.name, 'base');
    if (this.rows.length >= BATCH) this.flush();
  }

  flush() {
    if (!this.rows.length) return;
    // Sorted inserts land next to each other on disk, which keeps a small page cache effective
    this.rows.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    this.total += this.store.upsertDomains(this.rows);
    this.rows = [];
  }

  finish() {
    this.flush();
    if (this.shapes.size) this.store.bumpShapes(this.shapes);
    return this.total;
  }
}

// Public scam and phishing blocklists. URL feeds also give us a working link to visit
export const ingestFeeds = async (store, ctx, { feeds = 'default', log = () => {} } = {}) => {
  const started = Date.now();
  const loaded = {};
  for (const id of resolveFeeds(feeds)) {
    const feed = FEEDS[id];
    try {
      const response = await ctx.cachedText(feed.url, {
        ttl: TTL.feed,
        timeoutMs: 120000,
        maxBytes: 60 * 1024 * 1024,
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const loader = new Loader(store);
      const samples = [];
      const bit = FEED_BITS[feed.kind] | (feed.format === 'urls' ? SRC.URLFEED : 0);
      for (const [host, url] of parseFeed(response.text, feed.format)) {
        const name = registrableDomain(host);
        if (!DOMAIN.test(name)) continue;
        loader.add({ name, src: bit, ns: nameScore(name) });
        if (url) samples.push([name, url]);
      }
      loaded[id] = loader.finish();
      if (samples.length) store.saveSamples(samples);
      log(`${feed.name}: ${loaded[id].toLocaleString('en')} names`);
    } catch (error) {
      ctx.noteError(`feed:${id}`, error);
      log(`${feed.name}: failed (${error.message})`);
    }
  }
  return {
    source: 'feeds',
    loaded,
    names: Object.values(loaded).reduce((sum, count) => sum + count, 0),
    ms: Date.now() - started,
  };
};

// Common Crawl names its web graphs after the three months they cover
const graphIds = (now = new Date()) => {
  const ids = [];
  for (let back = 1; back <= 14; back += 1) {
    const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - back, 1));
    const months = [-2, -1, 0].map(
      (shift) => new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() + shift, 1)),
    );
    const firstYear = months[0].getUTCFullYear();
    const lastYear = months[2].getUTCFullYear();
    const year =
      firstYear === lastYear ? `${firstYear}` : `${firstYear}-${String(lastYear).slice(2)}`;
    ids.push(`cc-main-${year}-${months.map((month) => MONTHS[month.getUTCMonth()]).join('-')}`);
  }
  return ids;
};

const graphUrl = (id) =>
  `https://data.commoncrawl.org/projects/hyperlinkgraph/${id}/domain/${id}-domain-ranks.txt.gz`;

// "com.example.shop" in the graph files is shop.example.com
const unreverse = (reversed) => reversed.split('.').reverse().join('.');

// The web's domains ranked by how central they are in the link graph (Common Crawl).
// This is the backbone of the index: millions of established names with a rank each,
// streamed from the top of one file so that only as much as is wanted gets downloaded
export const ingestRanked = async (store, ctx, { limit = 15000000, log = () => {} } = {}) => {
  const started = Date.now();
  let graph = store.getMeta('ranked:graph');
  let source = null;
  // About 29 compressed bytes per line; ask for a little more than the lines we want
  const range = { range: `bytes=0-${Math.ceil(limit * 31 + 1000000)}` };
  for (const id of graph ? [graph] : graphIds()) {
    try {
      source = await ctx.stream(graphUrl(id), { headers: range });
      graph = id;
      break;
    } catch (error) {
      if (error.status !== 404 && error.status !== 403) throw error;
    }
  }
  if (!source) throw new Error('No Common Crawl web graph could be found');
  store.setMeta('ranked:graph', graph);
  log(`Reading the top ${limit.toLocaleString('en')} domains of ${graph}`);

  store.db.exec('UPDATE shapes SET base = 0');
  const loader = new Loader(store, { baseline: true });
  let count = 0;
  let reported = 0;
  outer: for await (const lines of lineBatches(gunzipStream(source))) {
    for (const line of lines) {
      if (line.charCodeAt(0) === 35) continue; // header
      const fields = line.split('\t');
      const name = unreverse(fields[4] || '');
      if (!DOMAIN.test(name)) continue;
      loader.add({ name, src: SRC.RANKED, rank: Number(fields[0]), ns: nameScore(name) });
      count += 1;
      if (count >= limit) break outer;
    }
    if (count - reported >= 1000000) {
      reported = count;
      log(`  ${count.toLocaleString('en')} ranked domains loaded`);
    }
  }
  const names = loader.finish();
  return { source: 'ranked', graph, names, ms: Date.now() - started };
};

// The Tranco list: the million most-visited domains, averaged over several traffic rankings
export const ingestToplist = async (store, ctx, { log = () => {} } = {}) => {
  const started = Date.now();
  const response = await ctx.fetch('https://tranco-list.eu/top-1m.csv.zip', {
    timeoutMs: 120000,
    maxBytes: 40 * 1024 * 1024,
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} from tranco-list.eu`);
  const csv = unzipFirst(response.bytes).toString('utf8');
  const loader = new Loader(store);
  for (const line of csv.split('\n')) {
    const comma = line.indexOf(',');
    if (comma < 0) continue;
    const name = cleanHost(line.slice(comma + 1));
    if (DOMAIN.test(name))
      loader.add({
        name,
        src: SRC.TOPLIST,
        top: Number(line.slice(0, comma)),
        ns: nameScore(name),
      });
  }
  const names = loader.finish();
  log(`Tranco top list: ${names.toLocaleString('en')} names`);
  return { source: 'toplist', names, ms: Date.now() - started };
};

// Record names that are new to us, counting each new one toward its name shape exactly once
const addFresh = (store, loader, names, bit, seen) => {
  const known = store.prepare('SELECT src, rank, top FROM domains WHERE name = ?');
  let fresh = 0;
  for (const name of names) {
    const row = known.get(name);
    // Established names renew certificates all the time; only never-seen names are news
    if (!row || (!(row.src & (SRC.NRD | SRC.CT)) && !row.rank && !row.top)) {
      loader.tally(name, 'fresh');
      fresh += 1;
    }
    loader.add({ name, src: bit, ns: nameScore(name), seen });
  }
  return fresh;
};

// Domains registered in the last 30 days
export const ingestNrd = async (store, ctx, { log = () => {} } = {}) => {
  const started = Date.now();
  const source = await ctx.stream(
    'https://raw.githubusercontent.com/cenk/nrd/main/nrd-last-30-days.txt',
  );
  const loader = new Loader(store);
  let fresh = 0;
  let count = 0;
  for await (const lines of lineBatches(source)) {
    const names = [];
    for (const line of lines) {
      const name = line.trim().toLowerCase();
      if (name && name.charCodeAt(0) !== 35 && DOMAIN.test(name)) names.push(name);
    }
    fresh += addFresh(store, loader, names, SRC.NRD);
    count += names.length;
  }
  loader.finish();
  log(
    `Newly registered domains: ${count.toLocaleString('en')} names, ${fresh.toLocaleString('en')} new to the index`,
  );
  return { source: 'nrd', names: count, fresh, ms: Date.now() - started };
};

// The newest certificates from the public logs. Called every tick, it resumes where it stopped
export const ingestCt = async (
  store,
  ctx,
  { tiles = 20, backfill = 20, perOperator = 1, log = () => {} } = {},
) => {
  const started = Date.now();
  const logs = await activeLogs(ctx, { perOperator });
  const loader = new Loader(store);
  const stamp = seconds();
  let hosts = 0;
  let fresh = 0;
  let read = 0;
  const perLog = Math.max(1, Math.floor(tiles / Math.max(1, logs.length)));
  for (const item of logs) {
    const key = `ct:${item.url}`;
    try {
      const result = await readLog(ctx, item, {
        cursor: store.getMeta(key) ?? undefined,
        tiles: perLog,
        backfill,
      });
      store.setMeta(key, result.cursor);
      const domains = new Set();
      for (const host of result.names) {
        const name = registrableDomain(host.replace(/^\*\./, ''));
        if (DOMAIN.test(name)) domains.add(name);
      }
      hosts += result.names.length;
      read += result.tiles;
      fresh += addFresh(store, loader, domains, SRC.CT, stamp);
    } catch (error) {
      ctx.noteError(`ct:${item.name}`, error);
    }
  }
  const names = loader.finish();
  log(
    `Certificate logs: ${read} tiles from ${logs.length} logs, ${hosts.toLocaleString('en')} hostnames, ${fresh.toLocaleString('en')} domains new to the index`,
  );
  return {
    source: 'ct',
    logs: logs.length,
    tiles: read,
    hostnames: hosts,
    names,
    fresh,
    ms: Date.now() - started,
  };
};

export const SOURCES = {
  feeds: {
    run: ingestFeeds,
    about: 'Public scam and phishing blocklists (about 1.4 million names)',
  },
  ranked: {
    run: ingestRanked,
    about: 'Common Crawl web graph: the top domains of the web, ranked (default 15 million)',
  },
  toplist: { run: ingestToplist, about: 'Tranco: the million most-visited domains' },
  nrd: { run: ingestNrd, about: 'Domains registered in the last 30 days' },
  ct: { run: ingestCt, about: 'Newest TLS certificates from the public transparency logs (live)' },
};
