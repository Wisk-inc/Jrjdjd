// Turn the Radar database into what the Scam Radar pages read.
//
//   node tools/scam-radar/export.mjs [--db FILE] [--out assets/data/scam-radar.json]
//   node tools/scam-radar/export.mjs --all DIR      everything, for the scam-radar-data branch
//
// Files written with --all:
//   scam-radar.json          the snapshot /scam-radar/ draws
//   scam-radar-status.json   a few hundred bytes the page polls to see if there is a new snapshot
//   lookup/xx.json           one record per watched site, keyed by a hash of its name ("Check a site")
//   radar-map.json           the named sites in the shape Scam Finder's map viewer draws
//
// What is published, and why so little:
// - Counts by country are taken over every live, high-risk site Radar watches.
// - A site is NAMED only when the evidence is strong: it scores 70 or more, and either runs a scam
//   kit Radar recognises or is already on a public scam or phishing blocklist. A score from the
//   spelling of a name alone is never enough to name a site.
// - Names are defanged ("example[.]com") so they cannot be clicked.
// - From the scam page itself only the title is copied, for named sites, with phone numbers, emails,
//   links and handles removed. No page text, no contacts, no wallets, no tracking IDs: a contact on
//   a scam page is often someone else's hijacked account. Everything else comes from Radar's own
//   tables: the kit, the brand being impersonated, the kind of lure, the reasons behind the score.
// - The lookup holds records for sites that are not named, but under a hash, so it answers a
//   question about a site somebody already has. It cannot be read as a list.
import fs from 'node:fs';
import path from 'node:path';
import { BRANDS } from './scam-finder/data/brands.js';
import { buildCampaigns, buildLinks, describeShape } from './scam-finder/lib/graph.js';
import { categoryName } from './scam-finder/lib/radar/checker.js';
import { RadarStore, SRC, defaultDbPath } from './scam-finder/lib/radar/store.js';
import { overview, toMapDomain } from './scam-finder/lib/radar/view.js';
import { LEVELS } from './scam-finder/lib/score.js';
import { clean, cleanTitle, defang, hashOf, sanitizeCampaigns, sanitizeDomain, sanitizeLinks } from './sanitize.mjs';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const dbFile = flag('--db', defaultDbPath());
const allDir = flag('--all', null);
const outFile = flag('--out', allDir
  ? path.join(allDir, 'scam-radar.json')
  : path.join(import.meta.dirname, '..', '..', 'assets', 'data', 'scam-radar.json'));

const NAME_MIN_RISK = 70;
const COUNT_MIN_RISK = 60;
const LOOKUP_MIN_RISK = 40;
const NAMED_MAX = 500;
const MAP_MAX = 300;
const FEED_MAX = 80;
const LISTED = { PHISHING: 'phishing blocklist', SCAM: 'scam blocklist', CRYPTO: 'crypto-scam blocklist',
  THREAT: 'threat blocklist', URLFEED: 'live phishing feed' };
const HOUR = 3600;
const DAY = 86400;

const iso = (seconds) => (seconds ? new Date(seconds * 1000).toISOString() : null);
const country = (code) => (/^[A-Z]{2}$/.test(code || '') ? code : null);
const listedBy = (src) => Object.entries(LISTED).filter(([key]) => src & SRC[key]).map(([, label]) => label);
const count = (items) =>
  [...items.reduce((map, key) => map.set(key, (map.get(key) || 0) + 1), new Map())]
    .sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])));
const tally = (items) => count(items).map(([code, live]) => ({ country: code, live }));
const BRAND_COUNTRY = new Map(BRANDS.map((b) => [b.name, b.country || null]));
// A brand a site pretends to be: one named in its address or its title. A brand that only turns up
// somewhere in the page text (a "Continue with Facebook" button, say) is not being impersonated.
const brandsOf = (site) => [...new Set((site.detail?.brands || [])
  .filter((b) => !b.official && (b.inDomain || b.inTitle)).map((b) => clean(b.name)))].filter(Boolean);
const kitOf = (site) => clean(site.detail?.kits?.[0]?.name || site.detail?.kits?.[0]?.id) || null;
const targetsOf = (site) => [...new Set((site.detail?.targets || []).map((t) => country(t.country)).filter(Boolean))];
const kindOf = (site) => categoryName(site.category) || null;
// A host's own notice where the scam used to be. The page still answers, so Radar calls it live,
// but there is nothing left to warn about: it is counted as dealt with, not as a live scam.
const hostNotice = (site) =>
  /takedown notice|trust\s*(?:&|and)\s*safety|(?:site|page|project|app|account|deployment) (?:has been|was|is) (?:taken down|removed|suspended|disabled|blocked)/i.test(site.title || '');
const strong = (site) =>
  site.risk >= NAME_MIN_RISK && ((site.detail?.kits || []).length > 0 || listedBy(site.src).length > 0);

// What happened, in Radar's own words. Nothing from the page is repeated here.
const EVENT_TEXT = {
  'first-visit': () => 'Found live',
  'taken-down': (d) => `Taken down${d.reason ? `. ${clean(d.reason, 70)}` : ''}`,
  back: () => 'Came back online',
  title: () => 'Switched to a new lure',
  rebuilt: () => 'Page rebuilt with a different layout',
  content: () => 'Wording on the page changed',
  moved: () => 'Moved to a different server',
  nameservers: () => 'Nameservers changed',
  kit: (d, site) => `Scam kit detected${kitOf(site) ? `: ${kitOf(site)}` : ''}`,
  risk: (d) => `Risk went from ${clean(d.from, 10)} to ${clean(d.to, 10)}`,
  listed: (d) => `Added to a ${(d.on || []).map((l) => clean(l, 30)).join(', ') || 'blocklist'}`,
};
const eventText = (event, site) => (EVENT_TEXT[event.type] || (() => clean(event.type, 20)))(event.detail || {}, site);

const writeJson = (file, value, indent = 0) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, indent)}\n`);
};

if (!fs.existsSync(dbFile)) {
  console.error(`No Radar database at ${dbFile}. Build one with: node tools/scam-radar/scam-finder/cli.js radar ingest all`);
  process.exit(1);
}
const store = await RadarStore.open(dbFile);
try {
  const stats = store.stats({ refresh: true });
  const nowSec = Math.floor(Date.now() / 1000);
  const lastTick = store.getMeta('lastTick'); // the last cycle's report: { at, checks, ... }

  const up = store.listSites({ state: 'live', minRisk: COUNT_MIN_RISK, limit: 200000 }).filter((s) => s.checks > 0);
  const live = up.filter((s) => !hostNotice(s));
  const targets = tally(live.flatMap(targetsOf));
  const hosts = tally(live.filter((s) => !s.detail?.sharedNetwork).map((s) => country(s.country)).filter(Boolean));

  // Leaderboards, over every live high-risk site (counts only; nothing here names a site)
  const leaderboards = {
    countries: targets.slice(0, 25),
    hosting: hosts.slice(0, 25),
    brands: count(live.flatMap(brandsOf)).slice(0, 25)
      .map(([name, n]) => ({ name, country: BRAND_COUNTRY.get(name) || null, live: n })),
    kits: count(live.map(kitOf).filter(Boolean)).slice(0, 25).map(([name, n]) => ({ name, live: n })),
    kinds: count(live.map(kindOf).filter(Boolean)).slice(0, 15).map(([name, n]) => ({ name, live: n })),
    networks: count(live.filter((s) => !s.detail?.sharedNetwork && s.network).map((s) => `${clean(s.network, 50)}|${country(s.country) || ''}`))
      .slice(0, 25).map(([key, n]) => { const [name, cc] = key.split('|'); return { name, country: cc || null, live: n }; }),
  };

  // For the visitor's own country: how many sites aim at it, and which brands and kits they use
  const byCountry = {};
  for (const site of live) {
    for (const cc of targetsOf(site)) {
      const entry = (byCountry[cc] ||= { live: 0, brands: [], kits: [] });
      entry.live += 1;
      entry.brands.push(...brandsOf(site));
      const kit = kitOf(site);
      if (kit) entry.kits.push(kit);
    }
  }
  for (const entry of Object.values(byCountry)) {
    entry.brands = count(entry.brands).slice(0, 6).map(([name, n]) => ({ name, live: n }));
    entry.kits = count(entry.kits).slice(0, 4).map(([name, n]) => ({ name, live: n }));
  }

  const strongLive = live.filter(strong);
  const named = strongLive.slice(0, NAMED_MAX).map((site) => {
    const d = site.detail || {};
    return {
      domain: defang(site.name),
      risk: site.risk,
      title: cleanTitle(site.title),
      kind: kindOf(site),
      kit: kitOf(site),
      impersonates: brandsOf(site).slice(0, 3),
      lure: clean(d.lures?.[0]?.label) || null,
      targets: targetsOf(site),
      hostedIn: d.sharedNetwork ? null : country(site.country),
      behindSharedNetwork: Boolean(d.sharedNetwork),
      listedBy: listedBy(site.src),
      firstSeen: iso(site.first_seen),
      upShare: site.checks ? Math.round((100 * site.ups) / site.checks) : null,
    };
  });

  // Events, each tied to its site once. Asked for by kind, so a busy hour of first visits cannot
  // crowd the week's takedowns out of the window.
  const siteCache = new Map();
  const siteFor = (name) => {
    if (!siteCache.has(name)) siteCache.set(name, store.getSite(name));
    return siteCache.get(name);
  };
  const eventsOf = (query) => store.recentEvents(query)
    .map((event) => ({ event, site: siteFor(event.name) }))
    .filter(({ site }) => site && strong(site));

  // Takedowns of the last week, for sites that met the naming bar
  const takedowns = eventsOf({ since: nowSec - 7 * DAY, types: ['taken-down'], limit: 3000 })
    .slice(0, 100)
    .map(({ event, site }) => ({
      domain: defang(site.name),
      at: iso(event.at),
      reason: clean(event.detail?.reason || site.down_reason, 60) || null,
      livedHours: event.detail?.livedFor > 0 ? Math.round(event.detail.livedFor / HOUR) : null,
      targets: targetsOf(site),
    }));

  // The live feed: what Radar saw happen to named sites, newest first. A cycle finds over a hundred
  // sites live in the same second, so those are capped and the ones that say most come first,
  // which leaves room for the rarer events: takedowns, new lures, kits, moves.
  const feedItem = ({ event, site }) => ({
    at: iso(event.at),
    domain: defang(site.name),
    type: event.type,
    text: eventText(event, site),
    kind: kindOf(site),
    brand: brandsOf(site)[0] || null,
    title: cleanTitle(site.title),
    targets: targetsOf(site),
  });
  const CHANGE_TYPES = ['taken-down', 'back', 'title', 'rebuilt', 'content', 'moved', 'nameservers', 'kit', 'listed'];
  const changes = eventsOf({ since: nowSec - 2 * DAY, types: CHANGE_TYPES, limit: 4000 }).slice(0, FEED_MAX / 2);
  const telling = ({ site }) => Number(Boolean(kitOf(site))) + Number(brandsOf(site).length > 0) + Number(Boolean(kindOf(site)));
  const found = eventsOf({ since: nowSec - 2 * DAY, types: ['first-visit'], limit: 4000 })
    .filter(({ event, site }) => event.detail?.state === 'live' && !hostNotice(site))
    .slice(0, 600)
    .sort((a, b) => telling(b) - telling(a) || b.event.at - a.event.at)
    .slice(0, FEED_MAX - changes.length);
  const feed = [...changes, ...found].sort((a, b) => b.event.at - a.event.at).map(feedItem);

  // How busy the scanner has been, over every watched site (counts only)
  const activityOver = (seconds) => Object.fromEntries(
    store.prepare('SELECT type, count(*) AS n FROM events WHERE at >= ? GROUP BY type').all(nowSec - seconds)
      .map((row) => [row.type, row.n]));
  const activity = { hour: activityOver(HOUR), day: activityOver(DAY) };

  const view = overview(store);
  const snapshot = {
    generated: new Date().toISOString(),
    lastScan: typeof lastTick?.at === 'string' ? lastTick.at : null,
    scanCycles: Number(store.getMeta('ticks', 0)) || 0,
    totals: {
      domainsIndexed: stats.domains || 0,
      newlyRegistered: stats.registered || 0,
      fromCertificates: stats.certified || 0,
      alreadyBlocklisted: stats.listed || 0,
      worthVisiting: stats.hot || 0,
      inBulkBatches: stats.batched || 0,
      watched: stats.watched || 0,
      visited: stats.visited || 0,
      liveNow: stats.live || 0,
      liveHighRisk: live.length,
      critical: live.filter((s) => s.level === 'critical').length,
      replacedByHostNotice: up.length - live.length,
      named: strongLive.length,
      runningKnownKit: stats.kits || 0,
      takenDown: stats.takenDown || 0,
      visitsMade: stats.checks || 0,
      eventsLogged: stats.events || 0,
    },
    lastCycle: lastTick?.checks ? {
      visited: lastTick.checks.checked || 0,
      up: lastTick.checks.live || 0,
      down: lastTick.checks.down || 0,
      newFromCertificates: lastTick.certificates?.newDomains || 0,
      addedToWatchlist: lastTick.promoted || 0,
      seconds: lastTick.seconds || null,
    } : null,
    states: (view.byState || []).map((row) => ({ state: clean(row.key, 20), sites: row.sites })),
    targets,
    hosts,
    leaderboards,
    byCountry,
    named,
    namedTotal: strongLive.length,
    feed,
    activity,
    takedowns,
    batches: store.cohorts().slice(0, 12).map((cohort) => ({
      shape: clean(describeShape(cohort.shape), 60), names: cohort.size, timesOverRepresented: cohort.lift })),
    rules: {
      countsInclude: `live sites scoring ${COUNT_MIN_RISK} or more`,
      namedWhen: `scoring ${NAME_MIN_RISK} or more, and running a recognised scam kit or already on a public blocklist`,
    },
  };
  writeJson(outFile, snapshot, 1);
  console.log(`Wrote ${outFile}: ${live.length} live high-risk sites, ${strongLive.length} meet the naming bar, ${feed.length} feed items, ${takedowns.length} takedowns this week`);

  if (allDir) {
    writeJson(path.join(allDir, 'scam-radar-status.json'), {
      generated: snapshot.generated, lastScan: snapshot.lastScan, scanCycles: snapshot.scanCycles, totals: snapshot.totals });

    // ---- Lookup: one record per visited site with something to say, in 256 files by hash
    const worth = store.listSites({ minRisk: LOOKUP_MIN_RISK, limit: 1000000 }).filter((s) => s.checks > 0);
    const shards = new Map();
    for (const site of worth) {
      const d = site.detail || {};
      const isStrong = strong(site);
      const noticed = site.state === 'live' && hostNotice(site);
      const record = {
        state: noticed ? 'blocked' : clean(site.state, 20),
        risk: site.risk,
        level: clean(site.level, 10),
        named: isStrong || undefined,
        title: isStrong && !noticed ? cleanTitle(site.title) || undefined : undefined,
        kind: kindOf(site) || undefined,
        kit: kitOf(site) || undefined,
        brands: brandsOf(site).slice(0, 3),
        targets: targetsOf(site).slice(0, 6),
        hostedIn: d.sharedNetwork ? undefined : country(site.country) || undefined,
        shared: d.sharedNetwork ? true : undefined,
        network: clean(site.network, 50) || undefined,
        listedBy: listedBy(site.src),
        why: (d.signals || []).slice(0, 6).map((s) => clean(s.label, 90)).filter(Boolean),
        code: (d.findings || []).slice(0, 6)
          .map((f) => `${clean(f.label, 80)}${f.hidden ? ' (hidden in encoded script)' : ''}`).filter(Boolean),
        firstSeen: iso(site.first_seen),
        lastChecked: iso(site.last_check),
        checks: site.checks,
        upShare: site.checks ? Math.round((100 * site.ups) / site.checks) : undefined,
        downSince: iso(site.down_since) || undefined,
        takenDown: iso(site.taken_down) || undefined,
        downReason: noticed ? 'Its host has replaced the page with a takedown notice' : clean(site.down_reason, 80) || undefined,
        registered: clean(site.created, 10) || undefined,
        registrar: clean(site.registrar, 50) || undefined,
      };
      const key = hashOf(site.name);
      const shard = key.slice(0, 2);
      if (!shards.has(shard)) shards.set(shard, {});
      shards.get(shard)[key] = record;
    }
    fs.rmSync(path.join(allDir, 'lookup'), { recursive: true, force: true });
    for (let i = 0; i < 256; i += 1) {
      const shard = i.toString(16).padStart(2, '0');
      writeJson(path.join(allDir, 'lookup', `${shard}.json`), shards.get(shard) || {});
    }
    console.log(`Wrote ${worth.length} lookup records in 256 files`);

    // ---- The map: named sites, in the result shape Scam Finder's viewer draws
    const pool = store.listSites({ minRisk: NAME_MIN_RISK, limit: 5000 }).filter((s) => s.checks > 0 && strong(s) && !hostNotice(s));
    const picked = [...pool.filter((s) => s.state === 'live'), ...pool.filter((s) => s.state !== 'live')].slice(0, MAP_MAX);
    const eventsByName = new Map();
    for (let i = 0; i < picked.length; i += 200) {
      const names = picked.slice(i, i + 200).map((site) => site.name);
      const rows = store.prepare(
        `SELECT name, at, type, detail FROM events WHERE name IN (${names.map(() => '?').join(', ')}) ORDER BY at DESC, id DESC`,
      ).all(...names);
      for (const row of rows) {
        const list = eventsByName.get(row.name) || [];
        if (list.length < 12 && row.type !== 'watched') list.push({ ...row, detail: row.detail ? JSON.parse(row.detail) : null });
        eventsByName.set(row.name, list);
      }
    }
    const domains = picked.map((site) => toMapDomain(site, eventsByName.get(site.name) || []));
    const campaigns = buildCampaigns(domains);
    const links = buildLinks(domains);
    const sitesByName = new Map(picked.map((site) => [site.name, site]));

    // Strip what the scammers wrote, after the grouping above has used it
    for (const domain of domains) {
      const site = sitesByName.get(domain.domain);
      sanitizeDomain(domain);
      domain.track.events = (eventsByName.get(domain.domain) || []).map((event) =>
        ({ at: iso(event.at), type: event.type, text: eventText(event, site), detail: null }));
    }
    sanitizeCampaigns(campaigns);
    sanitizeLinks(links);
    const levels = Object.fromEntries(LEVELS.map((level) => [level.id, domains.filter((d) => d.risk.level === level.id).length]));
    const { lastTick: _tick, database: _database, batches, ...radar } = view;
    const map = {
      tool: 'scam-finder',
      version: 1,
      kind: 'radar',
      generatedAt: snapshot.generated,
      radar: { ...radar, batches: batches.map(({ examples: _examples, ...batch }) => ({ ...batch, examples: [] })),
        lastTick: null, ticks: snapshot.scanCycles, database: { file: 'radar.db', megabytes: Math.round((stats.fileBytes || 0) / 1048576) } },
      recent: feed.slice(0, 40).map((item) => ({ at: item.at, type: item.type, text: item.text, domain: item.domain.replace(/\[\.\]/g, '.'), detail: null })),
      domains,
      campaigns,
      links,
      pivots: [],
      sources: { errors: [] },
      options: { depth: 1 },
      partial: false,
      summary: {
        headline: `Radar has indexed ${snapshot.totals.domainsIndexed.toLocaleString('en')} domains and is watching ${snapshot.totals.watched.toLocaleString('en')} suspect sites. ${snapshot.totals.liveNow.toLocaleString('en')} are up right now and ${snapshot.totals.takenDown.toLocaleString('en')} have been taken down while watched. This map shows the ${domains.length.toLocaleString('en')} with the strongest evidence.`,
        domains: domains.length,
        related: domains.length,
        levels,
        live: domains.filter((d) => d.state === 'live').length,
        offline: domains.filter((d) => d.state === 'offline').length,
        campaigns: campaigns.length,
        firstSeen: null,
        lastSeen: null,
        targets: count(domains.flatMap((d) => d.targets.map((t) => t.country))).slice(0, 12).map(([cc, n]) => ({ country: cc, domains: n })),
        registrars: [],
        networks: [],
        tlds: [],
        seedScore: null,
        seedLevel: null,
      },
    };
    writeJson(path.join(allDir, 'radar-map.json'), map);
    console.log(`Wrote the map: ${domains.length} sites, ${campaigns.length} campaigns, ${links.length} shared fingerprints`);
  }
} finally {
  store.close();
}
