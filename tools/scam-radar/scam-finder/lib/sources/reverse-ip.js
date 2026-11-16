// Reverse IP: which other domains sit on the same server
// Only meaningful for dedicated hosts, so callers skip CDN and big-cloud addresses

import { TTL } from '../net.js';
import { cleanHost, registrableDomain, uniq } from '../util.js';

// More co-hosted domains than this means shared hosting, where neighbours are strangers
export const SHARED_HOST_THRESHOLD = 150;

const thc = async (ctx, ip) => {
  const data = await ctx.cachedJson('https://ip.thc.org/api/v1/lookup', {
    method: 'POST',
    body: { ip_address: ip, limit: 200 },
    ttl: TTL.rdap,
    timeoutMs: 15000,
    maxBytes: 4 * 1024 * 1024,
  });
  return {
    total: Number(data.matching_records) || (data.domains || []).length,
    hosts: (data.domains || []).map((row) => cleanHost(row.domain)).filter(Boolean),
  };
};

const hackerTarget = async (ctx, ip) => {
  const response = await ctx.cachedText(`https://api.hackertarget.com/reverseiplookup/?q=${ip}`, {
    ttl: TTL.rdap,
    timeoutMs: 12000,
  });
  const body = response.text.trim();
  if (!response.ok || /error|api count|quota|no dns/i.test(body)) {
    throw new Error('HackerTarget reverse IP is unavailable (free quota used up)');
  }
  const hosts = body.split('\n').map(cleanHost).filter(Boolean);
  return { total: hosts.length, hosts };
};

// Domains seen on an address, with a flag for when there are too many to mean anything
export const reverseIp = async (ctx, ip) => {
  for (const [name, lookup] of [
    ['ip.thc.org', thc],
    ['hackertarget', hackerTarget],
  ]) {
    try {
      const found = await lookup(ctx, ip);
      return {
        ip,
        source: name,
        total: found.total,
        shared: found.total > SHARED_HOST_THRESHOLD,
        domains: uniq(found.hosts.map(registrableDomain)).slice(0, 200),
      };
    } catch (error) {
      ctx.noteError(name, error);
      if (error.code === 'BUDGET') break;
    }
  }
  return null;
};
