// The investigation itself: profile a suspect site, pivot on what makes it distinctive,
// check what comes back, and score everything on evidence
//
//   depth 0  profile the target only
//   depth 1  also find sites sharing its fingerprints (kit files, titles, servers, certificates)
//   depth 2  repeat from the campaigns found at depth 1

import { PROFILES } from '../data/profiles.js';
import { analyzeCode } from './analyzer.js';
import { ipInfo, lookupDomain, nameserverKey, SHARED_NETWORKS } from './dns.js';
import { buildCampaigns, buildLinks, summarize, toGraph } from './graph.js';
import {
  findBrands,
  findLures,
  isWellKnown,
  lexical,
  matchSignatures,
  nameShape,
  targetCountries,
  urlShape,
  usableTitle,
} from './heuristics.js';
import { DESKTOP_UA, MOBILE_UA, NetContext } from './net.js';
import { crawlPage, distinctiveResources, hashResources, rootFingerprint } from './page.js';
import { lookupRdap } from './rdap.js';
import { LINK_LABELS, LINK_WEIGHTS, scoreProfile } from './score.js';
import { certificates } from './sources/ct.js';
import { FeedIndex } from './sources/feeds.js';
import { reverseIp } from './sources/reverse-ip.js';
import * as urlscan from './sources/urlscan.js';
import { revealLure, rootFromPage, visitSite } from './visit.js';
import {
  Budget,
  cleanHost,
  daysBetween,
  loadPsl,
  mapLimit,
  normalizeTitle,
  parseTarget,
  registrableDomain,
  stripEmoji,
  uniq,
} from './util.js';

export const DEFAULTS = {
  depth: 1,
  maxDomains: 400,
  maxResultsPerPivot: 300,
  maxPivots: 12,
  pages: 15,
  rdap: 25,
  feeds: 'default',
  timeBudgetMs: 240000,
  userAgent: 'mobile',
};

// Smaller limits for callers that must answer within a web request
export const QUICK = {
  depth: 1,
  maxDomains: 150,
  maxResultsPerPivot: 200,
  maxPivots: 6,
  pages: 5,
  rdap: 8,
  feeds: 'light',
  timeBudgetMs: 30000,
};

// A search that matches more scans than this is a common file or title, not a fingerprint
const TOO_COMMON = 3000;

const clampInt = (value, fallback, min, max) => {
  if (value === 'all') return max;
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(max, Math.max(min, Math.round(number))) : fallback;
};

const normalizeOptions = (options = {}) => {
  const base = { ...DEFAULTS, ...(options.quick ? QUICK : {}) };
  const merged = {
    ...base,
    ...Object.fromEntries(Object.entries(options).filter(([, v]) => v !== undefined)),
  };
  return {
    ...merged,
    depth: clampInt(merged.depth, base.depth, 0, 2),
    maxDomains: clampInt(merged.maxDomains, base.maxDomains, 1, 2000),
    maxResultsPerPivot: clampInt(merged.maxResultsPerPivot, base.maxResultsPerPivot, 10, 1000),
    maxPivots: clampInt(merged.maxPivots, base.maxPivots, 1, 40),
    pages: clampInt(merged.pages, base.pages, 0, 2000),
    rdap: clampInt(merged.rdap, base.rdap, 0, 2000),
    timeBudgetMs: clampInt(merged.timeBudgetMs, base.timeBudgetMs, 5000, 3600000),
  };
};

const userAgentFor = (choice) => {
  if (!choice || choice === 'mobile') return MOBILE_UA;
  if (choice === 'desktop') return DESKTOP_UA;
  return String(choice);
};

// Keep what's useful from a page profile and drop the bulk before it goes into a report
const trimPage = (page) => {
  if (!page) return page;
  const { text, resources, rawHtml, ...rest } = page;
  void rawHtml;
  return {
    ...rest,
    textSample: (text || '').slice(0, 280),
    resources: (resources || []).slice(0, 12).map(({ kind, host, path }) => ({ kind, host, path })),
    resourceCount: (resources || []).length,
  };
};

class Investigation {
  constructor(options) {
    this.options = normalizeOptions(options);
    this.ctx =
      options?.ctx ||
      new NetContext({
        budget: new Budget(this.options.timeBudgetMs),
        cacheDir: this.options.cacheDir,
      });
    this.domains = new Map();
    this.pivots = new Map();
    this.feeds = null;
    this.seed = null;
    this.truncated = false;
    this.started = Date.now();
    this.userAgent = userAgentFor(this.options.userAgent);
  }

  progress(stage, message) {
    try {
      this.options.onProgress?.({ stage, message, elapsedMs: Date.now() - this.started });
    } catch {
      // A broken progress listener must not break the investigation
    }
  }

  // Get or create the record for a domain
  touch(domain, depth) {
    let profile = this.domains.get(domain);
    if (!profile) {
      profile = {
        domain,
        role: 'related',
        depth,
        hosts: new Set([domain]),
        scanList: [],
        scanIds: new Set(),
        foundBy: [],
      };
      this.domains.set(domain, profile);
    }
    return profile;
  }

  hasRoomFor(domain) {
    if (this.domains.has(domain) || this.domains.size < this.options.maxDomains + 1) return true;
    this.truncated = true;
    return false;
  }

  addFoundBy(profile, entry) {
    const exists = profile.foundBy.some(
      (item) => item.type === entry.type && item.value === entry.value,
    );
    if (!exists) profile.foundBy.push(entry);
  }

  // Fold scan-archive hits into domain records, noting which pivot surfaced each one
  ingestScans(scans, pivot, keep = () => true) {
    let kept = 0;
    for (const scan of scans) {
      if (!scan.domain || !keep(scan)) continue;
      const link = {
        type: pivot.type,
        value: pivot.value,
        from: pivot.from || null,
        depth: pivot.depth,
      };
      if (
        scan.domain !== this.seed?.domain &&
        !isWellKnown(scan.host) &&
        this.hasRoomFor(scan.domain)
      ) {
        const profile = this.touch(scan.domain, pivot.depth);
        profile.hosts.add(scan.host);
        if (!profile.scanIds.has(scan.id)) {
          profile.scanIds.add(scan.id);
          profile.scanList.push(scan);
        }
        this.addFoundBy(profile, link);
        kept += 1;
      } else if (scan.domain === this.seed?.domain) {
        const profile = this.domains.get(scan.domain);
        if (profile && !profile.scanIds.has(scan.id)) {
          profile.scanIds.add(scan.id);
          profile.scanList.push(scan);
        }
      }
      // The address that was submitted, when it bounced the scanner to a different site
      const submitted = scan.submittedUrl ? safeDomain(scan.submittedUrl) : null;
      if (
        submitted &&
        submitted !== scan.domain &&
        submitted !== this.seed?.domain &&
        !isWellKnown(submitted) &&
        this.hasRoomFor(submitted)
      ) {
        const redirector = this.touch(submitted, pivot.depth);
        this.addFoundBy(redirector, {
          type: 'redirect',
          value: scan.domain,
          from: scan.domain,
          depth: pivot.depth,
        });
      }
    }
    return kept;
  }

  // Add a domain found without a scan (a certificate sibling, a redirect target, a feed hit)
  addCandidate(host, link) {
    const name = cleanHost(host);
    const domain = registrableDomain(name);
    if (!domain || !domain.includes('.') || domain === this.seed?.domain || isWellKnown(name))
      return null;
    if (!this.hasRoomFor(domain)) return null;
    const profile = this.touch(domain, link.depth);
    profile.hosts.add(name);
    this.addFoundBy(profile, link);
    return profile;
  }

  queuePivot(list, pivot) {
    const key = `${pivot.type}:${pivot.value}`;
    if (this.pivots.has(key)) return;
    const record = { ...pivot, status: 'planned' };
    this.pivots.set(key, record);
    list.push(record);
  }

  async runSearchPivot(pivot, keep) {
    const found = await urlscan.search(this.ctx, pivot.query, {
      maxResults: this.options.maxResultsPerPivot,
    });
    pivot.total = found.total;
    pivot.windowDays = found.windowDays;
    if (found.error) pivot.error = found.error;
    if (found.total > TOO_COMMON && pivot.type !== 'query') {
      pivot.status = 'too-common';
      pivot.kept = 0;
      return;
    }
    pivot.kept = this.ingestScans(found.scans, pivot, keep);
    pivot.status = found.error && !found.scans.length ? 'error' : 'ok';
  }

  // Everything we can learn about the starting point itself
  async profileSeed(target) {
    const { ctx } = this;
    const profile = this.touch(target.domain, 0);
    profile.role = 'seed';
    profile.hosts.add(target.host);
    profile.seedUrl = target.url;
    this.progress('seed', `Profiling ${target.domain}`);

    const origin = new URL(target.url).origin;
    const [dns, registration, page, root, certs, history] = await Promise.all([
      lookupDomain(ctx, target.host, {
        full: true,
        zone: target.isIp ? target.host : target.domain,
      }),
      target.isIp ? null : lookupRdap(ctx, target.domain),
      crawlPage(ctx, target.url, { userAgent: this.userAgent }).catch((error) => ({
        error: error.message,
      })),
      target.hasPath
        ? rootFingerprint(ctx, origin, { userAgent: this.userAgent }).catch(() => null)
        : null,
      target.isIp ? null : certificates(ctx, target.domain),
      // Earlier scans of this site, on any of its hostnames
      urlscan.search(
        ctx,
        `page.domain:${urlscan.quote(target.host)} OR page.apexDomain:${urlscan.quote(target.domain)}`,
        { maxResults: 100 },
      ),
    ]);

    profile.dns = dns;
    profile.registration = registration;
    profile.root = root;
    profile.certificates = certs;
    if (page.error) {
      profile.live = { ok: false, error: page.error };
    } else {
      profile.page = page;
      profile.live = { ok: true, status: page.status, checkedUrl: page.requestedUrl };
      // Given a bare domain, the page we fetched is the front page
      if (!target.hasPath) profile.root = rootFromPage(page);
    }
    profile.historyWindowDays = history.windowDays;
    this.ingestScans(history.scans, { type: 'history', value: target.domain, depth: 0 });

    const addresses = target.isIp ? [target.host] : dns.a.slice(0, 4);
    profile.network = await Promise.all(addresses.map((ip) => ipInfo(ctx, ip)));
    if (profile.page) {
      profile.resourceHashes = await hashResources(ctx, profile.page.resources, 3);
    }
    return profile;
  }

  // Searches worth running from a profiled site, most specific first
  planSeedPivots(profile) {
    const list = [];
    const from = profile.domain;
    const page = profile.page;
    const kits = page || profile.root ? matchSignatures(profile, page?.rawHtml) : [];
    profile.kits = kits;

    for (const kit of kits) {
      for (const pivot of kit.pivots) {
        this.queuePivot(list, {
          type: 'kit',
          value: pivot.value,
          query: `${pivot.type}:${urlscan.quote(pivot.value)}`,
          from,
          depth: 1,
          why: `Other sites serving a file from the "${kit.name}"`,
          kit: kit.id,
        });
      }
    }
    const kitValues = new Set(list.map((pivot) => pivot.value));
    for (const resource of distinctiveResources(page?.resources)) {
      const value = resource.path.replace(/^\//, '');
      if (kitValues.has(value)) continue;
      this.queuePivot(list, {
        type: 'filename',
        value,
        query: `filename:${urlscan.quote(value)}`,
        from,
        depth: 1,
        why: 'Other sites serving a file at the same unusual path',
      });
    }
    for (const item of profile.resourceHashes || []) {
      this.queuePivot(list, {
        type: 'hash',
        value: item.sha256,
        query: `hash:${item.sha256}`,
        from,
        depth: 1,
        why: `Other sites serving a byte-identical copy of ${item.path}`,
      });
    }
    const title = page?.title || profile.scanList.find((scan) => usableTitle(scan.title))?.title;
    if (title && usableTitle(title)) {
      const text = stripEmoji(title);
      this.queuePivot(list, {
        type: 'title',
        value: text,
        query: `page.title:${urlscan.quote(text)}`,
        from,
        depth: 1,
        why: 'Other sites showing the same page title',
      });
    }
    this.queuePivot(list, {
      type: 'mentions',
      value: from,
      query: `domain:${urlscan.quote(from)} AND NOT page.apexDomain:${urlscan.quote(from)}`,
      from,
      depth: 1,
      why: 'Pages on other sites that loaded something from this domain',
    });
    for (const address of profile.network || []) {
      if (!address.asn || address.shared) continue;
      this.queuePivot(list, {
        type: 'ip',
        value: address.ip,
        query: `page.ip:${urlscan.quote(address.ip)}`,
        from,
        depth: 1,
        why: `Other sites on the same server (${address.asnName || `AS${address.asn}`})`,
      });
    }
    return list.slice(0, this.options.maxPivots);
  }

  // Sites the Radar scanner has already visited and found running the same kit as the seed.
  // They arrive with what Radar saw, so none of them needs fetching again
  addRadarSiblings(seedProfile) {
    const store = this.options.radar;
    const kit = seedProfile.kits?.[0];
    if (!store || !kit) return 0;
    const sites = store
      .prepare(
        "SELECT * FROM sites WHERE kit = ? AND state = 'live' ORDER BY last_check DESC LIMIT ?",
      )
      .all(kit.id, this.options.maxDomains);
    let added = 0;
    for (const row of sites) {
      const link = {
        type: 'radar',
        value: kit.name,
        from: seedProfile.domain,
        depth: 1,
      };
      const profile = this.addCandidate(row.name, link);
      if (!profile || profile.live) continue;
      const detail = row.detail ? JSON.parse(row.detail) : {};
      profile.live = {
        ok: true,
        status: detail.status || 200,
        checkedUrl: detail.checkedUrl || null,
      };
      profile.kits = (detail.kits || []).map((item) => ({ ...item, score: 3, pivots: [] }));
      profile.root = detail.rootSample
        ? { sample: detail.rootSample, length: detail.rootSample.length, status: 200 }
        : null;
      profile.page = {
        title: row.title,
        description: detail.description || null,
        status: detail.status || 200,
        bodyLength: 2000,
        requestedUrl: detail.checkedUrl || null,
        og: { spoofedHost: detail.spoofedHost || null },
        trackers: detail.trackers || [],
        contacts: detail.contacts || [],
        structure: row.struct_hash,
        resources: [],
        externalHosts: [],
        stages: [],
        forms: { count: 0, passwordFields: 0, cardFields: 0, actionHosts: [] },
        behaviour: {},
      };
      profile.findings = detail.findings || [];
      if (row.created)
        profile.registration = {
          registrar: row.registrar,
          created: row.created,
          ageDays: daysBetween(row.created),
          abuseEmail: detail.abuseEmail || null,
          statuses: [],
          nameservers: [],
        };
      if (row.ip) {
        profile.network = [
          {
            ip: row.ip,
            asn: row.asn,
            asnName: row.network,
            country: row.country,
            shared: detail.sharedNetwork ? row.network : null,
          },
        ];
        profile.dns = { status: 'ok', a: [row.ip], ns: row.ns ? row.ns.split(' + ') : [] };
      }
      profile.radar = {
        firstSeen: row.first_seen,
        lastCheck: row.last_check,
        checks: row.checks,
        ups: row.ups,
      };
      added += 1;
    }
    this.pivots.set(`radar:${kit.id}`, {
      type: 'radar',
      value: kit.name,
      depth: 1,
      why: 'Sites the Radar scanner has confirmed are running this kit',
      status: 'ok',
      total: sites.length,
      kept: added,
    });
    return added;
  }

  // Leads that need no search: they're already in what the seed told us
  addDirectLinks(profile) {
    const from = profile.domain;
    for (const sibling of profile.certificates?.siblings || []) {
      this.addCandidate(sibling, { type: 'certificate', value: from, from, depth: 1 });
    }
    for (const host of profile.page?.redirectHosts || []) {
      this.addCandidate(host, { type: 'redirect', value: from, from, depth: 1 });
    }
    for (const host of profile.page?.externalHosts || []) {
      this.addCandidate(host, { type: 'loads-from', value: from, from, depth: 1 });
    }
  }

  async runIpPivot(pivot) {
    const found = await reverseIp(this.ctx, pivot.value);
    if (!found || found.shared) {
      pivot.reverse = found ? { total: found.total, shared: true } : null;
      return;
    }
    pivot.reverse = { total: found.total, shared: false, source: found.source };
    for (const domain of found.domains) {
      this.addCandidate(domain, {
        type: 'ip',
        value: pivot.value,
        from: pivot.from,
        depth: pivot.depth,
      });
    }
  }

  async runPivots(list, keep) {
    for (const pivot of list) {
      if (this.ctx.outOfTime(8000)) {
        pivot.status = 'skipped';
        continue;
      }
      this.progress('pivot', `${pivot.why} (${pivot.type})`);
      await this.runSearchPivot(pivot, keep);
      if (pivot.type === 'ip') await this.runIpPivot(pivot);
    }
  }

  related() {
    return [...this.domains.values()].filter((profile) => profile.role !== 'seed');
  }

  // Pick a spread of domains: the newest from each distinct title before any second helpings
  spread(profiles, limit) {
    const groups = new Map();
    for (const profile of profiles) {
      const latest = latestScan(profile);
      const key = normalizeTitle(latest?.title) || `~${profile.foundBy[0]?.type || ''}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(profile);
    }
    const queues = [...groups.values()].map((group) =>
      group.sort((a, b) =>
        String(latestScan(b)?.time || '').localeCompare(String(latestScan(a)?.time || '')),
      ),
    );
    queues.sort((a, b) => b.length - a.length);
    const picked = [];
    while (picked.length < limit && queues.some((queue) => queue.length)) {
      for (const queue of queues) {
        const next = queue.shift();
        if (next) picked.push(next);
        if (picked.length >= limit) break;
      }
    }
    return picked;
  }

  // Visit related sites ourselves: is the kit still there, and what is it showing today?
  async checkPages(profiles) {
    await mapLimit(profiles, 5, async (profile) => {
      if (this.ctx.outOfTime(6000) || profile.live) return;
      const latest = latestScan(profile);
      const visit = await visitSite(this.ctx, {
        domain: profile.domain,
        sampleUrl: latest?.submittedUrl || latest?.url,
        userAgent: this.userAgent,
      });
      profile.live = visit.live;
      if (visit.root) profile.root = visit.root;
      if (visit.page) profile.page = visit.page;
      if (visit.takedown) profile.takedown = visit.takedown;
      if (!visit.live.ok) return;
      profile.kits = matchSignatures(profile, profile.page?.rawHtml);
      if (await revealLure(this.ctx, profile, profile.kits, { userAgent: this.userAgent })) {
        profile.kits = matchSignatures(profile, profile.page.rawHtml);
      }
    });
  }

  // Second-round searches: each distinct campaign title found so far, biggest first
  planFollowUps() {
    const list = [];
    const titles = new Map();
    const servers = new Map();
    for (const profile of this.related()) {
      for (const title of uniq([
        profile.page?.title,
        ...profile.scanList.map((scan) => scan.title),
      ])) {
        if (!title || !usableTitle(title)) continue;
        const key = normalizeTitle(title);
        const entry = titles.get(key) || { title, domains: new Set() };
        entry.domains.add(profile.domain);
        titles.set(key, entry);
      }
      for (const scan of profile.scanList) {
        if (!scan.ip || !scan.asn || SHARED_NETWORKS[scan.asn]) continue;
        const entry = servers.get(scan.ip) || { asnName: scan.asnName, domains: new Set() };
        entry.domains.add(profile.domain);
        servers.set(scan.ip, entry);
      }
    }
    const byReach = (a, b) => b[1].domains.size - a[1].domains.size;
    for (const [, entry] of [...titles].sort(byReach)) {
      const text = stripEmoji(entry.title);
      this.queuePivot(list, {
        type: 'title',
        value: text,
        query: `page.title:${urlscan.quote(text)}`,
        from: [...entry.domains][0],
        depth: 2,
        why: `More sites titled "${text.slice(0, 50)}"`,
      });
    }
    for (const [ip, entry] of [...servers].sort(byReach).slice(0, 4)) {
      this.queuePivot(list, {
        type: 'ip',
        value: ip,
        query: `page.ip:${urlscan.quote(ip)}`,
        from: [...entry.domains][0],
        depth: 2,
        why: `Other sites on ${ip} (${entry.asnName || 'dedicated server'})`,
      });
    }
    for (const profile of this.related()) {
      for (const resource of distinctiveResources(profile.page?.resources, 2)) {
        const value = resource.path.replace(/^\//, '');
        this.queuePivot(list, {
          type: 'filename',
          value,
          query: `filename:${urlscan.quote(value)}`,
          from: profile.domain,
          depth: 2,
          why: `Other sites serving ${value.slice(0, 50)}`,
        });
      }
    }
    return list.slice(0, this.options.maxPivots);
  }

  async enrichDns(profiles) {
    this.progress('dns', `Resolving ${profiles.length} domains`);
    await mapLimit(profiles, 8, async (profile) => {
      if (profile.dns || this.ctx.outOfTime(4000)) return;
      profile.dns = await lookupDomain(this.ctx, profile.domain);
      if (profile.network) return;
      const scan = latestScan(profile);
      const first = profile.dns.a[0];
      if (scan?.asn && (!first || scan.ip === first)) {
        profile.network = [
          {
            ip: scan.ip,
            asn: scan.asn,
            asnName: scan.asnName,
            country: scan.country,
            shared: SHARED_NETWORKS[scan.asn] || null,
          },
        ];
      } else if (first) {
        profile.network = [await ipInfo(this.ctx, first)];
      }
    });
  }

  async enrichRegistration(profiles) {
    if (!profiles.length) return;
    this.progress('registration', `Looking up registration for ${profiles.length} domains`);
    await mapLimit(profiles, 4, async (profile) => {
      if (profile.registration || this.ctx.outOfTime(4000)) return;
      profile.registration = await lookupRdap(this.ctx, profile.domain);
    });
  }

  // Derive the per-domain facts that scoring and grouping need
  describe(profile) {
    const scans = profile.scanList
      .slice()
      .sort((a, b) => String(a.time).localeCompare(String(b.time)));
    const latest = scans[scans.length - 1];
    const titleCounts = new Map();
    for (const scan of scans) {
      if (scan.title) titleCounts.set(scan.title, (titleCounts.get(scan.title) || 0) + 1);
    }
    const rankedTitles = [...titleCounts].sort((a, b) => b[1] - a[1]);
    const aged = scans.filter((scan) => scan.domainAgeDays !== null && scan.time);
    const lastAged = aged[aged.length - 1];
    if (scans.length) {
      profile.scans = {
        count: scans.length,
        first: scans[0].time,
        last: latest.time,
        titles: rankedTitles.slice(0, 4).map(([title, count]) => ({ title, count })),
        urls: uniq(
          scans
            .map((scan) => scan.url)
            .filter(Boolean)
            .reverse(),
        ).slice(0, 3),
        ips: uniq(scans.map((scan) => scan.ip).filter(Boolean)).slice(0, 6),
        server: latest.server,
        tags: uniq(scans.flatMap((scan) => scan.tags)).slice(0, 8),
        reports: scans
          .slice(-3)
          .reverse()
          .map((scan) => scan.report)
          .filter(Boolean),
        // Age when scanned plus the time since, so it reads as "age today"
        ageDays: lastAged
          ? lastAged.domainAgeDays + Math.max(0, daysBetween(lastAged.time) || 0)
          : null,
      };
    }

    const title = profile.page?.title || rankedTitles[0]?.[0] || null;
    const url = profile.seedUrl || profile.page?.requestedUrl || profile.scans?.urls[0] || null;
    profile.title = title;
    profile.urls = uniq([profile.seedUrl, ...(profile.scans?.urls || [])].filter(Boolean)).slice(
      0,
      4,
    );
    profile.lexical = lexical(profile.domain);
    profile.shape = nameShape(profile.domain);
    profile.urlShape = url ? urlShape(url) : null;
    const wording = [
      title,
      ...rankedTitles.map(([text]) => text),
      profile.page?.description,
      profile.page?.text,
    ]
      .filter(Boolean)
      .join(' \n ');
    profile.lures = findLures(wording);
    profile.brands = findBrands({
      title: rankedTitles
        .map(([text]) => text)
        .concat(title || '')
        .join(' | '),
      text: profile.page?.text,
      host: profile.domain,
    });
    profile.targets = targetCountries({
      title: rankedTitles
        .map(([text]) => text)
        .concat(title || '')
        .join(' '),
      brands: profile.brands,
      lures: profile.lures,
    });
    if (!profile.kits)
      profile.kits =
        profile.page || profile.root ? matchSignatures(profile, profile.page?.rawHtml) : [];
    if (profile.page?.rawHtml && !profile.findings) {
      const analysis = analyzeCode({
        html: profile.page.rawHtml,
        text: profile.page.text,
        host: profile.domain,
        externalHosts: profile.page.externalHosts,
        forms: profile.page.forms,
        isListed: this.feeds ? (host) => this.feeds.lookup(host).length > 0 : undefined,
      });
      profile.findings = analysis.findings;
      profile.codeLayers = analysis.layers;
    }
    profile.blocklists = this.feeds
      ? uniqueListings([...profile.hosts].flatMap((host) => this.feeds.lookup(host)))
      : [];
    profile.state = stateOf(profile);
    profile.created =
      profile.registration?.created ||
      (profile.scans?.ageDays != null ? estimateCreated(profile.scans.ageDays) : null);
    profile.createdIsEstimate = !profile.registration?.created && Boolean(profile.created);
    const pair = nameserverKey(
      profile.dns?.ns?.length ? profile.dns.ns : profile.registration?.nameservers,
    );
    profile.nameservers = pair;
  }

  // Mark groups that only show up across the whole set: naming batches and same-day registrations
  markBatches(profiles) {
    const shapes = new Map();
    const days = new Map();
    for (const profile of profiles) {
      if (profile.wellKnown) continue;
      if (!shapes.has(profile.shape)) shapes.set(profile.shape, []);
      shapes.get(profile.shape).push(profile);
      if (profile.created) {
        const day = profile.created.slice(0, 10);
        if (!days.has(day)) days.set(day, []);
        days.get(day).push(profile);
      }
    }
    for (const [shape, members] of shapes) {
      const machineMade = members.filter((profile) => profile.lexical.randomLooking).length;
      if (
        members.length >= 5 &&
        /^(letters|alnum)\d+\./.test(shape) &&
        machineMade >= members.length * 0.3
      ) {
        for (const profile of members) profile.cohort = { shape, size: members.length };
      }
    }
    for (const [date, members] of days) {
      if (members.length < 3) continue;
      for (const profile of members) profile.batch = { date, size: members.length };
    }
  }

  // How strongly each related site is tied to the seed, discounted if the seed looks innocent
  associate(profile, seedScore) {
    // With no known-bad starting point (a hunt), a link between two leads proves little
    const trust = seedScore === null ? 0.25 : Math.min(1, Math.max(0.15, seedScore / 70));
    const links = [];
    const seen = new Set();
    for (const found of profile.foundBy) {
      if (seen.has(found.type) || !LINK_WEIGHTS[found.type]) continue;
      seen.add(found.type);
      const solo = found.type === 'query' || found.type === 'keyword';
      links.push({
        type: found.type,
        weight: LINK_WEIGHTS[found.type] * (solo ? 1 : trust),
        label: LINK_LABELS[found.type],
        detail: String(found.value).slice(0, 120),
      });
    }
    profile.association = links.sort((a, b) => b.weight - a.weight).slice(0, 3);
  }

  finish(kind, extra) {
    const profiles = [...this.domains.values()];
    for (const profile of profiles) {
      profile.wellKnown = profile.role !== 'seed' && isWellKnown(profile.domain);
      this.describe(profile);
    }
    this.markBatches(profiles);

    const seedProfile = profiles.find((profile) => profile.role === 'seed') || null;
    let seedScore = null;
    if (seedProfile) {
      seedProfile.risk = scoreProfile(seedProfile);
      seedScore = seedProfile.risk.score;
    }
    for (const profile of profiles) {
      if (profile === seedProfile) continue;
      this.associate(profile, seedScore);
      profile.risk = scoreProfile(profile);
    }

    const domains = profiles
      .map(publicProfile)
      .sort(
        (a, b) =>
          (b.role === 'seed') - (a.role === 'seed') ||
          b.risk.score - a.risk.score ||
          a.domain.localeCompare(b.domain),
      );
    const campaigns = buildCampaigns(domains);
    const links = buildLinks(domains);
    const result = {
      tool: 'scam-finder',
      version: 1,
      kind,
      generatedAt: new Date().toISOString(),
      ...extra,
      domains,
      campaigns,
      links,
      pivots: [...this.pivots.values()].map((pivot) => ({ ...pivot })),
      sources: {
        feeds: this.feeds ? { loaded: this.feeds.counts, failed: this.feeds.failed } : null,
        urlscanWindowDays:
          [...this.pivots.values()].map((pivot) => pivot.windowDays).find(Boolean) ??
          seedProfile?.historyWindowDays ??
          null,
        urlscanKey: Boolean(process.env.URLSCAN_API_KEY),
        requests: this.ctx.stats.requests,
        cacheHits: this.ctx.stats.cacheHits,
        errors: this.ctx.errors,
      },
      options: publicOptions(this.options),
      elapsedMs: Date.now() - this.started,
      partial: this.ctx.outOfTime(0) || this.truncated,
      truncated: this.truncated,
    };
    result.summary = summarize(result);
    result.graph = toGraph(result);
    return result;
  }

  async runSeed(input) {
    await loadPsl();
    const target = parseTarget(input);
    this.seed = target;
    const { options } = this;
    const feedsLoading = FeedIndex.load(this.ctx, options.feeds);

    const seedProfile = await this.profileSeed(target);
    if (options.depth >= 1) {
      const pivots = this.planSeedPivots(seedProfile);
      this.addDirectLinks(seedProfile);
      await this.runPivots(pivots);
      const fromRadar = this.addRadarSiblings(seedProfile);
      if (fromRadar)
        this.progress('radar', `Radar adds ${fromRadar} confirmed copies of the same kit`);
      this.progress('pivot', `Found ${this.related().length} related domains`);

      if (options.pages > 0) {
        const picks = this.spread(this.related(), options.pages);
        this.progress('pages', `Checking ${picks.length} related sites live`);
        await this.checkPages(picks);
      }
      if (options.depth >= 2 && !this.ctx.outOfTime(15000)) {
        await this.runPivots(this.planFollowUps());
        this.progress(
          'pivot',
          `Now ${this.related().length} related domains after the second round`,
        );
      }
      const related = this.related();
      await this.enrichDns(related);
      await this.enrichRegistration(this.spread(related, options.rdap));
    } else {
      seedProfile.kits =
        seedProfile.page || seedProfile.root
          ? matchSignatures(seedProfile, seedProfile.page?.rawHtml)
          : [];
    }

    this.feeds = await feedsLoading;
    return this.finish('investigation', {
      seed: { input: target.input, url: target.url, host: target.host, domain: target.domain },
    });
  }

  async runHunt(spec) {
    await loadPsl();
    const { options } = this;
    const profileIds = spec.profiles || [];
    const unknown = profileIds.filter((id) => !PROFILES[id]);
    if (unknown.length) {
      throw new Error(
        `Unknown hunt profile: ${unknown.join(', ')}. Available: ${Object.keys(PROFILES).join(', ')}`,
      );
    }
    const queries = [];
    const keywords = new Set(
      (spec.keywords || []).map((word) => String(word).toLowerCase().trim()).filter(Boolean),
    );
    for (const id of profileIds) {
      const profile = PROFILES[id];
      for (const item of profile.queries)
        queries.push({ ...item, profile: id, targets: item.targetsOnly ? profile.targets : null });
      for (const word of profile.keywords) keywords.add(word);
    }
    for (const q of spec.queries || [])
      queries.push({ q, why: 'Custom query', profile: null, targets: null });
    if (!queries.length && !keywords.size) {
      throw new Error('Nothing to hunt for: give at least one profile, query or keyword');
    }

    const feedsLoading = FeedIndex.load(this.ctx, options.feeds);
    const list = [];
    for (const item of queries.slice(0, options.maxPivots)) {
      this.queuePivot(list, {
        type: 'query',
        value: item.q,
        query: item.q,
        from: null,
        depth: 1,
        why: item.why,
        profile: item.profile,
        targets: item.targets,
      });
    }
    for (const pivot of list) {
      if (this.ctx.outOfTime(8000)) {
        pivot.status = 'skipped';
        continue;
      }
      this.progress('hunt', pivot.why);
      const keep = pivot.targets
        ? (scan) =>
            targetCountries({
              title: scan.title,
              brands: findBrands({ title: scan.title, host: scan.host }),
              lures: findLures(scan.title),
            }).some((hit) => pivot.targets.includes(hit.country))
        : undefined;
      await this.runSearchPivot(pivot, keep);
    }

    this.feeds = await feedsLoading;
    for (const word of keywords) {
      if (word.length < 4) continue;
      // The word has to start a part of the name: "jncb-login", not a random string that
      // happens to contain those four letters
      const hits = this.feeds.filter((host) => keywordInHost(word, host), 150);
      this.pivots.set(`keyword:${word}`, {
        type: 'keyword',
        value: word,
        depth: 1,
        why: `Blocklisted hostnames containing "${word}"`,
        status: 'ok',
        total: hits.length,
        kept: hits.length,
      });
      for (const hit of hits)
        this.addCandidate(hit.host, { type: 'keyword', value: word, from: null, depth: 1 });
    }
    this.progress('hunt', `Collected ${this.domains.size} leads`);

    const leads = this.related();
    if (options.pages > 0) await this.checkPages(this.spread(leads, options.pages));
    await this.enrichDns(leads);
    await this.enrichRegistration(this.spread(leads, options.rdap));

    return this.finish('hunt', {
      hunt: {
        profiles: profileIds.map((id) => ({
          id,
          name: PROFILES[id].name,
          description: PROFILES[id].description,
        })),
        queries: queries.map((item) => item.q),
        keywords: [...keywords],
      },
    });
  }
}

const keywordInHost = (word, host) => {
  if (!host.includes(word)) return false;
  const label = registrableDomain(host).split('.')[0];
  if (lexical(host).randomLooking && !label.startsWith(word)) return false;
  return host
    .split(/[.-]/)
    .some((part) => part.startsWith(word) || (word.length >= 6 && part.includes(word)));
};

const safeDomain = (url) => {
  try {
    return registrableDomain(new URL(url).hostname);
  } catch {
    return null;
  }
};

const safeOrigin = (url) => {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
};

const latestScan = (profile) =>
  profile.scanList.reduce(
    (latest, scan) => (!latest || String(scan.time) > String(latest.time) ? scan : latest),
    null,
  );

const estimateCreated = (ageDays) =>
  new Date(Date.now() - ageDays * 86400000).toISOString().slice(0, 10);

const uniqueListings = (hits) => {
  const seen = new Set();
  return hits.filter((hit) => {
    if (seen.has(hit.feed)) return false;
    seen.add(hit.feed);
    return true;
  });
};

// live: it served us a page; offline: it no longer resolves; unreachable: it resolves but
// gave an error or no answer; resolves: in DNS but not visited; unknown: nobody checked
const stateOf = (profile) => {
  if (profile.takedown) return 'offline';
  if (profile.live?.ok) return profile.live.status < 400 ? 'live' : 'unreachable';
  if (profile.dns?.status === 'nxdomain' || profile.dns?.status === 'no-address') return 'offline';
  if (profile.registration?.notRegistered) return 'offline';
  if (/does not resolve/.test(profile.live?.error || '')) return 'offline';
  if (profile.live && !profile.live.ok) return 'unreachable';
  if (profile.dns?.status === 'ok') return 'resolves';
  return 'unknown';
};

const publicOptions = ({ onProgress, ctx, cacheDir, radar, ...options }) => {
  void onProgress;
  void ctx;
  void cacheDir;
  return { ...options, radar: Boolean(radar) };
};

// The shape that leaves this module: plain JSON, no working state
const publicProfile = (profile) => ({
  domain: profile.domain,
  role: profile.role,
  depth: profile.depth,
  state: profile.state,
  risk: profile.risk,
  title: profile.title,
  hosts: [...profile.hosts].sort().slice(0, 12),
  urls: profile.urls,
  targets: profile.targets,
  lures: profile.lures.map(({ id, label, cues }) => ({ id, label, cues })),
  brands: profile.brands.map(({ id, name, official, inDomain, inTitle }) => ({
    id,
    name,
    official,
    inDomain,
    inTitle,
  })),
  kits: profile.kits.map(({ id, name, category, description, evidence }) => ({
    id,
    name,
    category,
    description,
    evidence,
  })),
  blocklists: profile.blocklists,
  findings: profile.findings || [],
  foundBy: profile.foundBy,
  created: profile.created,
  createdIsEstimate: profile.createdIsEstimate,
  registration: profile.registration || null,
  nameservers: profile.nameservers,
  dns: profile.dns || null,
  network: profile.network || [],
  scans: profile.scans || null,
  live: profile.live || null,
  takedown: profile.takedown || null,
  structure: profile.page?.structure || null,
  page: trimPage(profile.page) || null,
  root: profile.root || null,
  certificates: profile.certificates || null,
  resourceHashes: profile.resourceHashes || undefined,
  lexical: profile.lexical,
  shape: profile.shape,
  cohort: profile.cohort || null,
  batch: profile.batch || null,
});

// Investigate one URL or domain and map what it is connected to
export const investigate = (input, options = {}) => new Investigation(options).runSeed(input);

// Search for fresh leads by profile ("jamaica", "lottery", ...), raw query or keyword
export const hunt = (spec, options = {}) => new Investigation(options).runHunt(spec);
