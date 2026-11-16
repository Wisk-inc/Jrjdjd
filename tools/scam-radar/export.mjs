// Turn the Radar database into the snapshot the Scam Radar page reads:
//   node tools/scam-radar/export.mjs [--db FILE] [--out assets/data/scam-radar.json]
//
// What it publishes, and why so little:
// - Counts by country are taken over every live, high-risk site Radar watches.
// - A site is NAMED only when the evidence is strong: it is up, scores 70 or more, and either runs a
//   scam kit Radar recognises or is already on a public scam or phishing blocklist. A score from the
//   spelling of a name alone is never enough to name a site.
// - Names are defanged ("example[.]com") so they cannot be clicked.
// - Nothing written by the scammers is copied: no page titles, no text, no phone numbers, emails or
//   wallets (a contact on a scam page is often someone else's hijacked account). Labels come from
//   Radar's own tables: the kit, the brand being impersonated, the kind of lure.
import fs from 'node:fs';
import path from 'node:path';
import { RadarStore, SRC, defaultDbPath } from './scam-finder/lib/radar/store.js';
import { BRANDS } from './scam-finder/data/brands.js';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const dbFile = flag('--db', defaultDbPath());
const outFile = flag('--out', path.join(import.meta.dirname, '..', '..', 'assets', 'data', 'scam-radar.json'));

const NAME_MIN_RISK = 70;
const COUNT_MIN_RISK = 60;
const LISTED = { PHISHING: 'phishing blocklist', SCAM: 'scam blocklist', CRYPTO: 'crypto-scam blocklist',
  THREAT: 'threat blocklist', URLFEED: 'live phishing feed' };
const DAY = 86400;

const iso = (seconds) => (seconds ? new Date(seconds * 1000).toISOString() : null);
const defang = (name) => String(name).toLowerCase().replace(/[^a-z0-9.-]/g, '').replace(/\./g, '[.]');
const country = (code) => (/^[A-Z]{2}$/.test(code || '') ? code : null);
const listedBy = (src) => Object.entries(LISTED).filter(([key]) => src & SRC[key]).map(([, label]) => label);
const clean = (text, max = 60) => String(text || '').replace(/[<>"'`]/g, '').replace(/\s+/g, ' ').trim().slice(0, max);

const count = (items) =>
  [...items.reduce((map, key) => map.set(key, (map.get(key) || 0) + 1), new Map())]
    .sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])));
const tally = (items) => count(items).map(([code, live]) => ({ country: code, live }));
const BRAND_COUNTRY = new Map(BRANDS.map((b) => [b.name, b.country || null]));
const brandsOf = (site) => [...new Set((site.detail?.brands || []).filter((b) => !b.official).map((b) => clean(b.name)))].filter(Boolean);
const kitOf = (site) => clean(site.detail?.kits?.[0]?.name || site.detail?.kits?.[0]?.id) || null;
const targetsOf = (site) => [...new Set((site.detail?.targets || []).map((t) => country(t.country)).filter(Boolean))];

if (!fs.existsSync(dbFile)) {
  console.error(`No Radar database at ${dbFile}. Build one with: node tools/scam-radar/scam-finder/cli.js radar ingest all`);
  process.exit(1);
}
const store = await RadarStore.open(dbFile);
try {
  const stats = store.stats({ refresh: true });
  const nowSec = Math.floor(Date.now() / 1000);
  const lastTick = store.getMeta('lastTick'); // the last cycle's report: { at, checks, ... }

  const live = store.listSites({ state: 'live', minRisk: COUNT_MIN_RISK, limit: 100000 }).filter((s) => s.checks > 0);
  const targets = tally(live.flatMap(targetsOf));
  const hosts = tally(live.filter((s) => !s.detail?.sharedNetwork).map((s) => country(s.country)).filter(Boolean));

  // Leaderboards, over every live high-risk site (counts only; nothing here names a site)
  const leaderboards = {
    countries: targets.slice(0, 25),
    brands: count(live.flatMap(brandsOf)).slice(0, 25)
      .map(([name, n]) => ({ name, country: BRAND_COUNTRY.get(name) || null, live: n })),
    kits: count(live.map(kitOf).filter(Boolean)).slice(0, 25).map(([name, n]) => ({ name, live: n })),
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

  const strong = (site) =>
    site.risk >= NAME_MIN_RISK && ((site.detail?.kits || []).length > 0 || listedBy(site.src).length > 0);

  const named = live
    .filter(strong)
    .map((site) => {
      const d = site.detail || {};
      return {
        domain: defang(site.name),
        risk: site.risk,
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
    })
    .slice(0, 300);

  // Takedowns of the last week, for sites that met the same bar
  const takedowns = store
    .recentEvents({ since: nowSec - 7 * DAY, types: ['taken-down'], limit: 2000 })
    .map((event) => ({ event, site: store.getSite(event.name) }))
    .filter(({ site }) => site && site.risk >= NAME_MIN_RISK && ((site.detail?.kits || []).length || listedBy(site.src).length))
    .slice(0, 100)
    .map(({ event, site }) => ({
      domain: defang(site.name),
      at: iso(event.at),
      reason: clean(event.detail?.reason || site.down_reason, 40) || null,
      targets: [...new Set((site.detail?.targets || []).map((t) => country(t.country)).filter(Boolean))],
    }));

  const snapshot = {
    generated: new Date().toISOString(),
    lastScan: typeof lastTick?.at === 'string' ? lastTick.at : null,
    scanCycles: Number(store.getMeta('ticks', 0)) || 0,
    totals: {
      domainsIndexed: stats.domains || 0,
      newlyRegistered: stats.registered || 0,
      fromCertificates: stats.certified || 0,
      alreadyBlocklisted: stats.listed || 0,
      watched: stats.watched || 0,
      liveHighRisk: live.length,
      named: named.length,
      runningKnownKit: stats.kits || 0,
      takenDown: stats.takenDown || 0,
      visitsMade: stats.checks || 0,
    },
    targets,
    hosts,
    leaderboards,
    byCountry,
    named,
    takedowns,
    rules: {
      countsInclude: `live sites scoring ${COUNT_MIN_RISK} or more`,
      namedWhen: `live, scoring ${NAME_MIN_RISK} or more, and running a recognised scam kit or already on a public blocklist`,
    },
  };
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, `${JSON.stringify(snapshot, null, 1)}\n`);
  console.log(`Wrote ${outFile}: ${live.length} live high-risk sites, ${named.length} named, ${takedowns.length} takedowns this week`);
} finally {
  store.close();
}
