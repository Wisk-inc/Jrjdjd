// One check of one watched site: is it up, what is it serving, and what changed
//
// Cheapest question first. A DNS lookup settles most checks of dead sites for a few
// hundred bytes; only sites that still resolve are fetched, and registration records are
// consulted only when something changes

import { analyzeCode } from '../analyzer.js';
import { ipInfo, lookupDomain, nameserverKey } from '../dns.js';
import {
  findBrands,
  findLures,
  lexical,
  matchSignatures,
  targetCountries,
  urlShape,
  usableTitle,
} from '../heuristics.js';
import { lookupRdap } from '../rdap.js';
import { scoreProfile } from '../score.js';
import { daysBetween, normalizeTitle } from '../util.js';
import { revealLure, visitSite } from '../visit.js';
import { SRC, SRC_LABELS, sourceNames } from './store.js';
import { nameScore, shapeOf } from './triage.js';

const MINUTE = 60;
const HOUR = 3600;
const DAY = 86400;
const LISTED = SRC.PHISHING | SRC.SCAM | SRC.CRYPTO | SRC.THREAT;

const seconds = () => Math.floor(Date.now() / 1000);

// How soon to look again: risky live sites often, dead ones less and less
export const nextInterval = (site) => {
  const jitter = 0.85 + Math.random() * 0.3;
  let wait;
  if (site.state === 'pending') wait = 10 * MINUTE;
  else if (site.state === 'live') {
    const young = seconds() - site.first_seen < DAY;
    wait = {
      critical: young ? 30 * MINUTE : 2 * HOUR,
      high: young ? HOUR : 4 * HOUR,
      medium: 8 * HOUR,
      low: 3 * DAY,
    }[site.level];
  } else if (site.state === 'resolves') wait = 12 * HOUR;
  else {
    // Down: 15 minutes, then doubling, so a takedown is confirmed fast and a comeback is caught
    wait = Math.min(2 * DAY, 15 * MINUTE * 2 ** Math.min(site.fails, 8));
    if (site.down_since && seconds() - site.down_since > 14 * DAY) wait = 7 * DAY;
  }
  return Math.round(wait * jitter);
};

const CATEGORY_NAMES = {
  giveaway: 'Giveaway or prize scam',
  phishing: 'Phishing',
  crypto: 'Crypto scam',
  malware: 'Malware delivery',
  'tech-support': 'Tech-support scam',
  lottery: 'Lottery or advance-fee scam',
  delivery: 'Delivery-fee scam',
  'government-benefit': 'Fake grant or benefit',
  'account-phishing': 'Phishing',
  investment: 'Fake investment platform',
  loan: 'Advance-fee loan',
  recovery: 'Fund-recovery scam',
  job: 'Job scam',
};
export const categoryName = (id) => CATEGORY_NAMES[id] || null;

// Why a domain earned a place on the watchlist, as a phrase
export const whyWatched = (row) => {
  const reasons = sourceNames(row.src)
    .filter((key) => !['RANKED', 'TOPLIST'].includes(key))
    .map((key) => SRC_LABELS[key]);
  const name = nameScore(row.name, true);
  return [...reasons, ...name.reasons].slice(0, 5).join('; ') || 'name triage';
};

const record = (events, type, detail) => events.push({ type, detail });

// Check one site and return it updated, with the events the check produced
export const checkSite = async (ctx, store, site, options = {}) => {
  const at = seconds();
  const events = [];
  const first = site.checks === 0;
  const before = {
    state: site.state,
    title: site.title,
    level: site.level,
    kit: site.kit,
    ip: site.ip,
    ns: site.ns,
    struct: site.struct_hash,
    content: site.content_hash,
  };
  const row = store.getDomain(site.name);
  const src = (row?.src || 0) | site.src;
  if (!first && src & LISTED && !(site.src & LISTED)) {
    record(events, 'listed', { on: sourceNames(src & LISTED).map((key) => SRC_LABELS[key]) });
  }
  site.src = src;
  site.rank = row?.rank || site.rank;
  site.top = row?.top || site.top;
  const detail = site.detail || {};

  const dns = await lookupDomain(ctx, site.name);
  if (dns.status === 'error') {
    // Our lookup failed, which says nothing about the site: try again shortly
    site.state = first ? 'pending' : site.state;
    site.next_check = at + 10 * MINUTE;
    return { site, events };
  }

  const profile = { domain: site.name, role: 'related', dns, urls: [], foundBy: [] };
  let up = false;
  let downReason = null;
  let visit = null;

  if (!dns.a.length && !(dns.aaaa || []).length) {
    downReason =
      dns.status === 'nxdomain'
        ? 'The domain no longer exists in DNS'
        : 'The domain has no address in DNS';
    site.state = 'offline';
  } else {
    site.ns = nameserverKey(dns.ns)?.key || null;
    const address = dns.a[0] || null;
    if (address && address !== site.ip) {
      const info = await ipInfo(ctx, address);
      site.ip = address;
      site.asn = info.asn || null;
      site.network = info.shared || info.asnName || null;
      site.country = info.shared ? null : info.country || null;
      detail.sharedNetwork = Boolean(info.shared);
    }
    visit = await visitSite(ctx, {
      domain: site.name,
      sampleUrl: store.sampleFor(site.name) || detail.url,
      userAgent: options.userAgent,
      timeoutMs: 8000,
      maxBytes: 300 * 1024,
      reserveMs: 2000,
    });
    profile.root = visit.root;
    profile.page = visit.page;
    if (!visit.live.ok && visit.live.code === 'BUDGET') {
      // We ran out of time, which says nothing about the site: look again soon
      site.state = first ? 'pending' : before.state;
      site.next_check = at + 5 * MINUTE;
      return { site, events };
    }
    if (!visit.live.ok) {
      downReason = /does not resolve/.test(visit.live.error)
        ? 'The domain has no address in DNS'
        : 'The server did not answer';
      site.state = /does not resolve/.test(visit.live.error) ? 'offline' : 'unreachable';
    } else if (visit.takedown) {
      downReason = visit.takedown.label;
      site.state = visit.takedown.kind;
    } else if (visit.live.status >= 400) {
      downReason = `The server answers with an error (HTTP ${visit.live.status})`;
      site.state = 'unreachable';
    } else {
      up = true;
      site.state = 'live';
    }
  }

  // Registration records cost a rate-limited lookup, so only on first sight or when it goes down
  const wentDown = !up && before.state === 'live';
  if (
    options.rdap &&
    options.rdap.left > 0 &&
    (wentDown || (up && !site.registrar && !detail.rdapTried))
  ) {
    options.rdap.left -= 1;
    detail.rdapTried = true;
    const registration = await lookupRdap(ctx, site.name);
    if (registration.notRegistered) {
      downReason = 'The registration has been deleted';
    } else if (!registration.unavailable) {
      site.registrar = registration.registrar || site.registrar;
      site.created = registration.created || site.created;
      detail.abuseEmail = registration.abuseEmail || detail.abuseEmail;
      const hold = (registration.statuses || []).find((status) => /hold/i.test(status));
      if (hold && !up) downReason = `Suspended at the registry or registrar (${hold})`;
      if (hold) detail.hold = hold;
    }
  }

  if (up) {
    let kits = matchSignatures(profile, profile.page?.rawHtml);
    if (
      await revealLure(ctx, profile, kits, { userAgent: options.userAgent, maxBytes: 300 * 1024 })
    ) {
      kits = matchSignatures(profile, profile.page.rawHtml);
    }
    const page = profile.page;
    const analysis = page?.rawHtml
      ? analyzeCode({
          html: page.rawHtml,
          text: page.text,
          host: site.name,
          externalHosts: page.externalHosts,
          forms: page.forms,
          isListed: (host) => ((store.getDomain(host)?.src || 0) & LISTED) !== 0,
        })
      : { findings: [], layers: 0 };
    const title = page?.title || null;
    profile.kits = kits;
    profile.findings = analysis.findings;
    profile.lures = findLures([title, page?.description, page?.text].filter(Boolean).join(' \n '));
    profile.brands = findBrands({ title: title || '', text: page?.text, host: site.name });
    profile.urlShape = page?.requestedUrl ? urlShape(page.requestedUrl) : null;

    site.title = title;
    site.title_key = title && usableTitle(title) ? normalizeTitle(title) : null;
    site.kit = kits[0]?.id || null;
    site.struct_hash = page?.structure || null;
    site.content_hash = page?.content || null;
    // What kind of scam it is: a recognised kit says so outright, then the most serious
    // thing its code does, then the wording of its bait
    site.category =
      kits[0]?.category ||
      analysis.findings.find((finding) => finding.severity === 3)?.category ||
      profile.lures[0]?.id ||
      site.category ||
      null;
    Object.assign(detail, {
      kits: kits.map(({ id, name, category, description, evidence }) => ({
        id,
        name,
        category,
        description,
        evidence,
      })),
      findings: analysis.findings,
      codeLayers: analysis.layers,
      lures: profile.lures.map(({ id, label, cues }) => ({ id, label, cues })),
      brands: profile.brands.map(({ id, name, official, inDomain, inTitle }) => ({
        id,
        name,
        official,
        inDomain,
        inTitle,
      })),
      targets: targetCountries({
        title: title || '',
        brands: profile.brands,
        lures: profile.lures,
      }),
      contacts: page?.contacts || [],
      trackers: page?.trackers || [],
      seo: page?.seo || null,
      description: page?.description || null,
      spoofedHost: page?.og?.spoofedHost || null,
      rootSample: profile.root?.sample || null,
      status: visit.live.status,
      checkedUrl: visit.checkedUrl,
    });
  }

  profile.lexical = lexical(site.name);
  profile.kits ||= [];
  profile.lures ||= detail.lures || [];
  profile.brands ||= detail.brands || [];
  profile.findings ||= up ? [] : detail.findings || [];
  profile.blocklists = sourceNames(src & LISTED).map((key) => ({
    feed: key,
    name: SRC_LABELS[key],
  }));
  if (src & SRC.URLFEED) profile.blocklists.push({ feed: 'URLFEED', name: SRC_LABELS.URLFEED });
  profile.registration = site.created ? { ageDays: daysBetween(site.created) } : null;
  if (src & SRC.COHORT) {
    const shape = shapeOf(site.name);
    const cohort = store.prepare('SELECT size FROM cohorts WHERE shape = ?').get(shape);
    if (cohort) profile.cohort = { shape, size: cohort.size };
  }
  // A site that has gone dark keeps the verdict it earned while it was up
  if (up || first || !site.risk) {
    const risk = scoreProfile(profile);
    site.risk = risk.score;
    site.level = risk.level;
    detail.signals = risk.signals.slice(0, 10);
  }

  // Counters, then the question everything else is here to answer: when did it go down?
  site.checks += 1;
  site.last_check = at;
  if (up) {
    if (site.taken_down || (before.state !== 'live' && !first && site.down_since)) {
      record(events, 'back', { after: site.down_since ? at - site.down_since : null });
    }
    site.ups += 1;
    site.fails = 0;
    site.first_up ||= at;
    site.last_up = at;
    site.down_since = null;
    site.taken_down = null;
    site.down_reason = null;
  } else {
    site.fails += 1;
    site.down_since ||= at;
    site.down_reason = downReason;
    // Two misses in a row, so one bad minute isn't recorded as a takedown
    if (site.fails >= 2 && site.last_up && !site.taken_down) {
      site.taken_down = site.down_since;
      record(events, 'taken-down', {
        reason: downReason,
        lastSeenUp: site.last_up,
        firstSeenDown: site.down_since,
        livedFor: site.down_since - (site.first_up || site.first_seen),
      });
    }
  }

  if (first) {
    record(events, 'first-visit', {
      state: site.state,
      risk: site.risk,
      title: site.title,
      reason: downReason,
    });
  } else {
    if (up && before.title && site.title && before.title !== site.title)
      record(events, 'title', { from: before.title, to: site.title });
    else if (up && before.struct && site.struct_hash && before.struct !== site.struct_hash)
      record(events, 'rebuilt', { note: 'The page was rebuilt with a different layout' });
    else if (up && before.content && site.content_hash && before.content !== site.content_hash)
      record(events, 'content', { note: 'The wording on the page changed' });
    if (before.ip && site.ip && before.ip !== site.ip && !detail.sharedNetwork)
      record(events, 'moved', { from: before.ip, to: site.ip, network: site.network });
    if (before.ns && site.ns && before.ns !== site.ns)
      record(events, 'nameservers', { from: before.ns, to: site.ns });
    if (before.kit !== site.kit && site.kit) record(events, 'kit', { kit: site.kit });
    if (before.level !== site.level)
      record(events, 'risk', { from: before.level, to: site.level, score: site.risk });
  }
  if (events.length && !first)
    site.changes += events.filter((event) =>
      ['title', 'rebuilt', 'content', 'moved', 'nameservers', 'kit'].includes(event.type),
    ).length;

  site.detail = detail;
  site.next_check = at + nextInterval(site);
  return { site, events, profile };
};

// The contact points, trackers and fingerprints that tie one site to others
export const indicatorsOf = (site) => {
  const detail = site.detail || {};
  const list = [];
  for (const item of detail.contacts || []) list.push({ kind: item.kind, value: item.id });
  for (const item of detail.trackers || []) list.push({ kind: item.kind, value: item.id });
  if (site.struct_hash && site.risk >= 40)
    list.push({ kind: 'structure', value: site.struct_hash });
  if (site.ip && !detail.sharedNetwork) list.push({ kind: 'server', value: site.ip });
  return list;
};
