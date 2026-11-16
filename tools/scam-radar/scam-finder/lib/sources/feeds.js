// Public scam and phishing blocklists, downloaded once and kept in the cache
// A listing is the strongest evidence there is: someone already reported the site

import { TTL } from '../net.js';
import { cleanHost, registrableDomain } from '../util.js';

const GITHUB = 'https://raw.githubusercontent.com';

// Every feed is free and needs no key. `heavy` ones are megabytes, so quick lookups skip them
export const FEEDS = {
  openphish: {
    name: 'OpenPhish',
    url: `${GITHUB}/openphish/public_feed/refs/heads/main/feed.txt`,
    format: 'urls',
    kind: 'phishing',
  },
  phishunt: {
    name: 'phishunt.io',
    url: 'https://phishunt.io/feed.txt',
    format: 'urls',
    kind: 'phishing',
  },
  gaso: {
    name: 'Global Anti-Scam Org',
    url: `${GITHUB}/elliotwutingfeng/GlobalAntiScamOrg-blocklist/main/global-anti-scam-org-scam-urls-pihole.txt`,
    format: 'domains',
    kind: 'scam',
  },
  scamblocklist: {
    name: 'Scam Blocklist (DurableNapkin)',
    url: `${GITHUB}/durablenapkin/scamblocklist/master/hosts.txt`,
    format: 'hosts',
    kind: 'scam',
  },
  'hagezi-fake': {
    name: 'HaGeZi Fake (scam shops and rip-offs)',
    url: `${GITHUB}/hagezi/dns-blocklists/main/wildcard/fake-onlydomains.txt`,
    format: 'domains',
    kind: 'scam',
  },
  certpl: {
    name: 'CERT Polska warning list',
    url: 'https://hole.cert.pl/domains/v2/domains.txt',
    format: 'domains',
    kind: 'phishing',
    heavy: true,
  },
  jarelllama: {
    name: "Jarelllama's Scam Blocklist",
    url: `${GITHUB}/jarelllama/Scam-Blocklist/main/lists/wildcard_domains/scams.txt`,
    format: 'domains',
    kind: 'scam',
    heavy: true,
  },
  'phishing-database': {
    name: 'Phishing.Database (active)',
    url: `${GITHUB}/Phishing-Database/Phishing.Database/master/phishing-domains-ACTIVE.txt`,
    format: 'domains',
    kind: 'phishing',
    heavy: true,
  },
  metamask: {
    name: 'MetaMask phishing list (crypto)',
    url: `${GITHUB}/MetaMask/eth-phishing-detect/main/src/config.json`,
    format: 'metamask',
    kind: 'crypto',
    heavy: true,
  },
  'hagezi-tif': {
    name: 'HaGeZi Threat Intelligence Feeds (medium)',
    url: `${GITHUB}/hagezi/dns-blocklists/main/wildcard/tif.medium-onlydomains.txt`,
    format: 'domains',
    kind: 'threat',
    heavy: true,
  },
};

const light = Object.keys(FEEDS).filter((id) => !FEEDS[id].heavy);

export const FEED_PRESETS = {
  none: [],
  light,
  default: [...light, 'certpl', 'jarelllama', 'phishing-database'],
  all: Object.keys(FEEDS),
};

// Turn a preset name, a comma list or an array into a list of known feed ids
export const resolveFeeds = (choice) => {
  if (choice === false || choice === 'none') return [];
  if (choice === undefined || choice === null || choice === true) return FEED_PRESETS.default;
  if (typeof choice === 'string' && FEED_PRESETS[choice]) return FEED_PRESETS[choice];
  const ids = Array.isArray(choice) ? choice : String(choice).split(',');
  return ids.map((id) => id.trim()).filter((id) => FEEDS[id]);
};

const HOST_RE = /^[a-z0-9_]([a-z0-9_-]*[a-z0-9_])?(\.[a-z0-9_]([a-z0-9_-]*[a-z0-9_])?)+$/;

const hostFromUrl = (line) => {
  try {
    return cleanHost(new URL(line).hostname);
  } catch {
    return null;
  }
};

// One feed's text into [host, url?] pairs
export const parseFeed = (text, format) => {
  const entries = [];
  if (format === 'metamask') {
    let config;
    try {
      config = JSON.parse(text);
    } catch {
      return entries;
    }
    for (const host of config.blacklist || []) {
      const name = cleanHost(host);
      if (HOST_RE.test(name)) entries.push([name, null]);
    }
    return entries;
  }
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line[0] === '#' || line[0] === '!') continue;
    if (format === 'urls') {
      const host = hostFromUrl(line);
      if (host) entries.push([host, line.slice(0, 500)]);
      continue;
    }
    // "0.0.0.0 example.com" in hosts files, "*.example.com" or "||example.com^" elsewhere
    const token = format === 'hosts' ? line.split(/\s+/)[1] : line.split(/\s+/)[0];
    const host = cleanHost((token || '').replace(/^\*\.|^\|\||\^$/g, ''));
    if (host && host !== '0.0.0.0' && HOST_RE.test(host)) entries.push([host, null]);
  }
  return entries;
};

// All loaded feeds in one lookup table
export class FeedIndex {
  constructor() {
    this.ids = [];
    this.hosts = new Map();
    this.urls = [];
    this.counts = {};
    this.failed = [];
  }

  add(id, entries) {
    const bit = 1 << this.ids.length;
    this.ids.push(id);
    this.counts[id] = entries.length;
    for (const [host, url] of entries) {
      this.hosts.set(host, (this.hosts.get(host) || 0) | bit);
      if (url) this.urls.push({ feed: id, host, url });
    }
  }

  // Download (or read from cache) each feed; one that's down doesn't stop the rest
  static async load(ctx, choice) {
    const index = new FeedIndex();
    const ids = resolveFeeds(choice);
    const loaded = await Promise.all(
      ids.map(async (id) => {
        try {
          const response = await ctx.cachedText(FEEDS[id].url, {
            ttl: TTL.feed,
            timeoutMs: 60000,
            maxBytes: 40 * 1024 * 1024,
          });
          if (!response.ok)
            throw new Error(`HTTP ${response.status} from the ${FEEDS[id].name} feed`);
          return [id, parseFeed(response.text, FEEDS[id].format)];
        } catch (error) {
          ctx.noteError(`feed:${id}`, error);
          index.failed.push(id);
          return [id, null];
        }
      }),
    );
    for (const [id, entries] of loaded) if (entries) index.add(id, entries);
    return index;
  }

  feedsFor(mask) {
    return this.ids.filter((id, position) => mask & (1 << position));
  }

  // Which feeds list this host, its parent domains, or the domain it was registered under
  lookup(hostname) {
    const host = cleanHost(hostname);
    const stop = registrableDomain(host);
    const hits = [];
    const seen = new Set();
    let current = host;
    while (current && current.includes('.')) {
      const mask = this.hosts.get(current);
      if (mask) {
        for (const id of this.feedsFor(mask)) {
          if (seen.has(id)) continue;
          seen.add(id);
          hits.push({ feed: id, name: FEEDS[id].name, kind: FEEDS[id].kind, listed: current });
        }
      }
      if (current === stop) break;
      current = current.slice(current.indexOf('.') + 1);
    }
    return hits;
  }

  // Listed hosts matching a test, for keyword and name-shape hunts
  filter(test, limit = 500) {
    const matches = [];
    for (const [host, mask] of this.hosts) {
      if (!test(host)) continue;
      matches.push({ host, feeds: this.feedsFor(mask) });
      if (matches.length >= limit) break;
    }
    return matches;
  }

  // Full URLs (only some feeds carry them) matching a test
  filterUrls(test, limit = 200) {
    return this.urls.filter((entry) => test(entry.url)).slice(0, limit);
  }

  get size() {
    return this.hosts.size;
  }
}
