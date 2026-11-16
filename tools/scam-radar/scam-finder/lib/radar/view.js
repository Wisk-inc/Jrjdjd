// Read-only views of the Radar database: headline numbers, one site's full history, and
// the watchlist shaped the way the map viewer expects

import { buildCampaigns, buildLinks, describeShape } from '../graph.js';
import { LEVELS } from '../score.js';
import { categoryName } from './checker.js';
import { SRC, SRC_LABELS, sourceNames } from './store.js';
import { nameScore, shapeOf } from './triage.js';

const iso = (stamp) => (stamp ? new Date(stamp * 1000).toISOString() : null);

// Radar's states, mapped onto the handful the map knows how to draw
const MAP_STATE = {
  live: 'live',
  resolves: 'resolves',
  new: 'unknown',
  pending: 'unknown',
  unreachable: 'unreachable',
};
const mapState = (state) => MAP_STATE[state] || 'offline';

const EVENT_TEXT = {
  watched: () => 'Put on the watchlist',
  'first-visit': (detail) =>
    detail.state === 'live'
      ? 'First visit: the site was up'
      : `First visit: already down (${detail.reason || detail.state})`,
  'taken-down': (detail) => `Taken down. ${detail.reason || ''}`.trim(),
  back: () => 'Came back online',
  title: (detail) => `Switched lure to "${String(detail.to).slice(0, 70)}"`,
  rebuilt: () => 'Page rebuilt with a different layout',
  content: () => 'Wording on the page changed',
  moved: (detail) => `Moved to a different server (${detail.to})`,
  nameservers: () => 'Nameservers changed',
  kit: (detail) => `Scam kit detected (${detail.kit})`,
  risk: (detail) => `Risk went from ${detail.from} to ${detail.to}`,
  listed: (detail) => `Added to a ${(detail.on || []).join(', ')}`,
};

export const describeEvent = (event) => ({
  at: iso(event.at),
  type: event.type,
  text: (EVENT_TEXT[event.type] || (() => event.type))(event.detail || {}),
  ...(event.name ? { domain: event.name } : {}),
  detail: event.detail,
});

// Share of checks that found the site up, and how long it lasted
export const lifespan = (site) => ({
  uptime: site.checks ? Math.round((100 * site.ups) / site.checks) : null,
  checks: site.checks,
  firstSeen: iso(site.first_seen),
  firstUp: iso(site.first_up),
  lastUp: iso(site.last_up),
  lastCheck: iso(site.last_check),
  nextCheck: iso(site.next_check),
  downSince: iso(site.down_since),
  takenDown: iso(site.taken_down),
  downReason: site.down_reason || null,
  // A takedown happened somewhere between the last good visit and the first bad one
  takedownWindow:
    site.taken_down && site.last_up
      ? { after: iso(site.last_up), before: iso(site.taken_down) }
      : null,
  livedSeconds: site.taken_down ? site.taken_down - (site.first_up || site.first_seen) : null,
  changes: site.changes,
});

const popularity = (site) => {
  if (site.top) return `#${site.top.toLocaleString('en')} by visits (Tranco)`;
  if (site.rank) return `#${site.rank.toLocaleString('en')} in the web link graph`;
  return 'Not in the top million by visits, nor the top 15 million by links';
};

// A watched site in the shape the map viewer draws
export const toMapDomain = (site, events = []) => {
  const detail = site.detail || {};
  const shared = Boolean(detail.sharedNetwork);
  const listed = sourceNames(site.src).filter((key) =>
    ['PHISHING', 'SCAM', 'CRYPTO', 'THREAT', 'URLFEED'].includes(key),
  );
  return {
    domain: site.name,
    role: 'related',
    depth: 1,
    state: mapState(site.state),
    risk: { score: site.risk, level: site.level, signals: detail.signals || [] },
    title: site.title,
    hosts: [site.name],
    urls: detail.checkedUrl ? [detail.checkedUrl] : [],
    targets: detail.targets || [],
    lures: detail.lures || [],
    brands: detail.brands || [],
    kits: detail.kits || [],
    findings: detail.findings || [],
    blocklists: listed.map((key) => ({ feed: key, name: SRC_LABELS[key] })),
    foundBy: [
      {
        type: site.src & SRC.COHORT ? 'batch' : listed.length ? 'listed' : 'triage',
        value: site.why || 'name triage',
        depth: 1,
      },
    ],
    created: site.created || null,
    createdIsEstimate: false,
    registration:
      site.registrar || detail.abuseEmail
        ? {
            registrar: site.registrar,
            created: site.created,
            abuseEmail: detail.abuseEmail || null,
          }
        : null,
    nameservers: site.ns
      ? { key: site.ns, accountLevel: /ns\.cloudflare\.com/.test(site.ns) }
      : null,
    network: site.ip
      ? [
          {
            ip: site.ip,
            asn: site.asn,
            asnName: site.network,
            country: site.country,
            shared: shared ? site.network : null,
          },
        ]
      : [],
    addresses: site.ip ? [site.ip] : [],
    scans: null,
    live: site.checks
      ? { ok: site.state === 'live', status: detail.status, error: site.down_reason }
      : null,
    structure: site.risk >= 40 ? site.struct_hash : null,
    page: {
      description: detail.description || null,
      spoofedHost: detail.spoofedHost || null,
      trackers: detail.trackers || [],
      contacts: detail.contacts || [],
      stages: [],
    },
    root: detail.rootSample ? { sample: detail.rootSample } : null,
    cohort: site.src & SRC.COHORT ? { shape: shapeOf(site.name), size: 0 } : null,
    batch: null,
    category: categoryName(site.category),
    seo: detail.seo || null,
    track: {
      ...lifespan(site),
      state: site.state,
      popularity: popularity(site),
      why: site.why,
      events: events.map(describeEvent),
    },
  };
};

// Everything known about one domain, watched or not
export const siteReport = (store, name) => {
  const row = store.getDomain(name);
  const site = store.getSite(name);
  if (!row && !site) return null;
  const triage = nameScore(name, true);
  const report = {
    domain: name,
    indexed: row
      ? {
          sources: sourceNames(row.src).map((key) => SRC_LABELS[key]),
          firstSeen: iso(row.seen),
          webGraphRank: row.rank || null,
          trafficRank: row.top || null,
          triageScore: row.score,
          nameSignals: triage.reasons,
        }
      : null,
    watched: Boolean(site),
  };
  if (!site) return report;
  const detail = site.detail || {};
  const shared = store.sharedIndicators(name);
  const groups = new Map();
  for (const item of shared) {
    const key = `${item.kind}:${item.value}`;
    if (!groups.has(key)) groups.set(key, { kind: item.kind, value: item.value, sites: [] });
    if (groups.get(key).sites.length < 25) groups.get(key).sites.push(item.other);
  }
  return {
    ...report,
    state: site.state,
    risk: { score: site.risk, level: site.level, signals: detail.signals || [] },
    category: categoryName(site.category),
    kit: detail.kits?.[0] || null,
    title: site.title,
    targets: detail.targets || [],
    whyWatched: site.why,
    lifespan: lifespan(site),
    popularity: popularity(site),
    hosting: {
      ip: site.ip,
      network: site.network,
      country: detail.sharedNetwork ? null : site.country,
      behindSharedNetwork: Boolean(detail.sharedNetwork),
      nameservers: site.ns,
    },
    registration: {
      registrar: site.registrar,
      created: site.created,
      abuseEmail: detail.abuseEmail || null,
      hold: detail.hold || null,
    },
    code: { findings: detail.findings || [], encodedLayers: detail.codeLayers || 0 },
    contacts: detail.contacts || [],
    trackers: detail.trackers || [],
    seo: detail.seo || null,
    sharedWith: [...groups.values()],
    events: store.eventsFor(name, 60).map(describeEvent),
  };
};

const countBy = (rows, key) => {
  const counts = new Map();
  for (const row of rows) if (row[key]) counts.set(row[key], (counts.get(row[key]) || 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1]);
};

// Headline numbers for the whole database
export const overview = (store, { refresh = false } = {}) => {
  const stats = store.stats({ refresh });
  const breakdown = (column) =>
    store
      .prepare(
        `SELECT ${column} AS key, count(*) AS sites FROM sites WHERE ${column} IS NOT NULL AND checks > 0 GROUP BY ${column} ORDER BY sites DESC LIMIT 12`,
      )
      .all();
  return {
    indexed: {
      domains: stats.domains,
      ranked: stats.ranked,
      trafficRanked: stats.toplisted,
      blocklisted: stats.listed,
      newlyRegistered: stats.registered,
      fromCertificates: stats.certified,
      inBulkBatches: stats.batched,
      worthVisiting: stats.hot,
    },
    watched: {
      sites: stats.watched || 0,
      visited: stats.visited || 0,
      live: stats.live || 0,
      takenDown: stats.takenDown || 0,
      critical: stats.critical || 0,
      high: stats.high || 0,
      runningAKnownKit: stats.kits || 0,
      checksMade: stats.checks || 0,
      eventsLogged: stats.events,
    },
    byState: breakdown('state'),
    byCategory: breakdown('category').map((row) => ({
      ...row,
      key: categoryName(row.key) || row.key,
    })),
    byKit: breakdown('kit'),
    byNetwork: breakdown('network'),
    batches: store
      .cohorts()
      .slice(0, 15)
      .map((cohort) => ({
        shape: describeShape(cohort.shape),
        names: cohort.size,
        timesOverRepresented: cohort.lift,
        examples: cohort.sample.slice(0, 4),
      })),
    lastTick: store.getMeta('lastTick'),
    ticks: store.getMeta('ticks', 0),
    database: { file: stats.file, megabytes: Math.round(stats.fileBytes / 1048576) },
  };
};

// The watchlist as a map: same result shape as an investigation, so the same viewer draws it
export const radarMap = (store, { limit = 800, minRisk = 40, query, state } = {}) => {
  const sites = store.listSites({ limit, minRisk, query, state }).filter((site) => site.checks > 0);
  const eventsByName = new Map();
  if (sites.length) {
    const marks = sites.map(() => '?').join(', ');
    const rows = store
      .prepare(
        `SELECT name, at, type, detail FROM events WHERE name IN (${marks}) ORDER BY at DESC, id DESC`,
      )
      .all(...sites.map((site) => site.name));
    for (const row of rows) {
      if (!eventsByName.has(row.name)) eventsByName.set(row.name, []);
      if (eventsByName.get(row.name).length < 12)
        eventsByName
          .get(row.name)
          .push({ ...row, detail: row.detail ? JSON.parse(row.detail) : null });
    }
  }
  const domains = sites.map((site) => toMapDomain(site, eventsByName.get(site.name) || []));
  const campaigns = buildCampaigns(domains);
  const links = buildLinks(domains);
  const stats = overview(store);
  const levels = Object.fromEntries(
    LEVELS.map((level) => [
      level.id,
      domains.filter((domain) => domain.risk.level === level.id).length,
    ]),
  );
  const targets = countBy(
    domains.flatMap((domain) => domain.targets.map((target) => ({ country: target.country }))),
    'country',
  ).map(([country, count]) => ({ country, domains: count }));
  const takedowns = store
    .recentEvents({ limit: 40, types: ['taken-down', 'back', 'title', 'kit', 'listed'] })
    .map(describeEvent);
  return {
    tool: 'scam-finder',
    version: 1,
    kind: 'radar',
    generatedAt: new Date().toISOString(),
    radar: stats,
    recent: takedowns,
    domains,
    campaigns,
    links,
    pivots: [],
    sources: { errors: [] },
    options: { depth: 1 },
    partial: false,
    summary: {
      headline: `Radar has indexed ${stats.indexed.domains.toLocaleString('en')} domains and is watching ${stats.watched.sites.toLocaleString('en')} suspect sites. ${stats.watched.live.toLocaleString('en')} are up right now and ${stats.watched.takenDown.toLocaleString('en')} have been taken down while watched.`,
      domains: domains.length,
      related: domains.length,
      levels,
      live: domains.filter((domain) => domain.state === 'live').length,
      offline: domains.filter((domain) => domain.state === 'offline').length,
      campaigns: campaigns.length,
      firstSeen: null,
      lastSeen: null,
      targets: targets.slice(0, 12),
      registrars: [],
      networks: [],
      tlds: [],
      seedScore: null,
      seedLevel: null,
    },
  };
};
