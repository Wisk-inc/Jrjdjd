// DNS over HTTPS, plus who-owns-this-IP lookups through Team Cymru's DNS service
// HTTPS-only on purpose: it works from sandboxes and serverless hosts that block raw DNS

import { TTL } from './net.js';
import { cleanHost, isIp, isPrivateIp } from './util.js';

const RESOLVERS = [
  { url: 'https://dns.google/resolve', headers: {} },
  { url: 'https://cloudflare-dns.com/dns-query', headers: { accept: 'application/dns-json' } },
];

const TYPE_NUMBERS = { A: 1, NS: 2, CNAME: 5, SOA: 6, MX: 15, TXT: 16, AAAA: 28 };

// Networks that front huge numbers of unrelated sites, where a shared IP proves nothing
export const SHARED_NETWORKS = {
  13335: 'Cloudflare',
  209242: 'Cloudflare',
  54113: 'Fastly',
  20940: 'Akamai',
  16625: 'Akamai',
  21342: 'Akamai',
  60068: 'CDN77',
  19551: 'Imperva',
  30148: 'Sucuri',
  199524: 'Gcore',
  16509: 'Amazon',
  14618: 'Amazon',
  15169: 'Google',
  396982: 'Google Cloud',
  8075: 'Microsoft',
  36459: 'GitHub',
  58182: 'Wix',
  53831: 'Squarespace',
  27647: 'Weebly',
  62679: 'Shopify',
  2635: 'Automattic',
  13238: 'Yandex',
  45102: 'Alibaba Cloud',
  132203: 'Tencent Cloud',
};

const unquoteTxt = (data) => String(data).replace(/^"|"$/g, '').replace(/" "/g, '');

// One DNS question; returns the answer strings, [] for "no such record", null on failure
export const resolve = async (ctx, name, type) => {
  const host = cleanHost(name);
  const params = `?name=${encodeURIComponent(host)}&type=${type}`;
  let lastError = null;
  for (const resolver of RESOLVERS) {
    try {
      const data = await ctx.cachedJson(`${resolver.url}${params}`, {
        headers: resolver.headers,
        ttl: TTL.dns,
        timeoutMs: 8000,
        maxBytes: 256 * 1024,
      });
      // Status 3 is NXDOMAIN: a real answer, just an empty one
      if (data.Status !== 0 && data.Status !== 3) {
        lastError = new Error(`DNS status ${data.Status} for ${host}`);
        continue;
      }
      const wanted = TYPE_NUMBERS[type];
      const answers = (data.Answer || [])
        .filter((answer) => answer.type === wanted)
        .map((answer) => (type === 'TXT' ? unquoteTxt(answer.data) : cleanHost(answer.data)));
      return { answers, nxdomain: data.Status === 3 };
    } catch (error) {
      lastError = error;
      if (error.code === 'BUDGET') break;
    }
  }
  ctx.noteError('dns', lastError);
  return null;
};

// The records that matter for linking sites together
export const lookupDomain = async (ctx, domain, { full = false, zone = domain } = {}) => {
  const types = full ? ['A', 'NS', 'MX', 'TXT', 'SOA', 'AAAA'] : ['A', 'NS'];
  // Nameservers live at the registered domain, not at each hostname beneath it
  const results = await Promise.all(
    types.map((type) => resolve(ctx, type === 'NS' || type === 'SOA' ? zone : domain, type)),
  );
  const record = { status: 'ok' };
  types.forEach((type, index) => {
    record[type.toLowerCase()] = results[index]?.answers || [];
  });
  if (results.every((result) => result === null)) record.status = 'error';
  else if (results.some((result) => result?.nxdomain)) record.status = 'nxdomain';
  else if (!record.a.length && !(record.aaaa || []).length) record.status = 'no-address';
  record.ns.sort();
  if (record.soa?.length) {
    // "ns1.example.com. hostmaster.example.com. 2024 ..." keeps only the two names
    const [primary, contact] = record.soa[0].split(/\s+/);
    record.soa = { primary: cleanHost(primary), contact: cleanHost(contact) };
  } else {
    delete record.soa;
  }
  return record;
};

const asnNames = new Map();

// Network owner for an AS number, like "CLOUDFLARENET - Cloudflare, Inc., US"
const asnName = async (ctx, asn) => {
  if (asnNames.has(asn)) return asnNames.get(asn);
  const result = await resolve(ctx, `AS${asn}.asn.cymru.com`, 'TXT');
  // "13335 | US | arin | 2010-07-14 | CLOUDFLARENET - Cloudflare, Inc., US"
  const name = result?.answers[0]?.split('|').pop()?.trim() || null;
  asnNames.set(asn, name);
  return name;
};

const cymruName = (ip) => {
  if (ip.includes(':')) {
    const [head, tail = ''] = ip.split('::');
    const left = head ? head.split(':') : [];
    const right = tail ? tail.split(':') : [];
    const groups = [...left, ...new Array(8 - left.length - right.length).fill('0'), ...right];
    const nibbles = groups.map((group) => group.padStart(4, '0')).join('');
    return `${[...nibbles].reverse().join('.')}.origin6.asn.cymru.com`;
  }
  return `${ip.split('.').reverse().join('.')}.origin.asn.cymru.com`;
};

// ASN, network name and country for an address, flagged when it's a shared CDN or cloud
export const ipInfo = async (ctx, ip) => {
  const address = cleanHost(ip);
  if (!isIp(address) || isPrivateIp(address)) return { ip: address };
  const result = await resolve(ctx, cymruName(address), 'TXT');
  // "13335 | 104.21.0.0/19 | US | arin | 2014-03-28"
  const parts = result?.answers[0]?.split('|').map((part) => part.trim());
  if (!parts || !parts[0]) return { ip: address };
  const asn = Number(parts[0].split(' ')[0]);
  const name = await asnName(ctx, asn);
  return {
    ip: address,
    asn,
    asnName: name,
    prefix: parts[1] || null,
    country: parts[2] || null,
    shared: SHARED_NETWORKS[asn] || null,
  };
};

// Cloudflare hands each account a fixed pair of nameservers, so a matching pair is a (soft) link
export const nameserverKey = (nameservers) => {
  const names = (nameservers || []).map(cleanHost).filter(Boolean).sort();
  if (!names.length) return null;
  const provider = names[0].split('.').slice(-3).join('.');
  if (provider === 'ns.cloudflare.com') {
    return { key: names.join(' + '), provider: 'Cloudflare', accountLevel: true };
  }
  // Elsewhere nameservers are per-provider, so only the provider is worth recording
  return { key: names[0].split('.').slice(-2).join('.'), provider: null, accountLevel: false };
};
