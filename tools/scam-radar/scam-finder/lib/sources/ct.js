// Certificate Transparency: every TLS certificate is logged in public, with all its hostnames
// A certificate issued for several unrelated-looking domains ties them to one operator

import { TTL } from '../net.js';
import { cleanHost, registrableDomain, uniq } from '../util.js';

const certSpotter = async (ctx, domain) => {
  const token = process.env.CERTSPOTTER_TOKEN;
  const params = new URLSearchParams({ domain, include_subdomains: 'true', expand: 'dns_names' });
  const rows = await ctx.cachedJson(`https://api.certspotter.com/v1/issuances?${params}`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
    ttl: TTL.rdap,
    timeoutMs: 15000,
    maxBytes: 4 * 1024 * 1024,
  });
  if (!Array.isArray(rows)) throw new Error('Unexpected reply from Cert Spotter');
  return rows.map((row) => ({ names: row.dns_names || [], notBefore: row.not_before || null }));
};

const crtSh = async (ctx, domain) => {
  const rows = await ctx.cachedJson(`https://crt.sh/?q=${encodeURIComponent(domain)}&output=json`, {
    ttl: TTL.rdap,
    timeoutMs: 20000,
    maxBytes: 8 * 1024 * 1024,
  });
  if (!Array.isArray(rows)) throw new Error('Unexpected reply from crt.sh');
  return rows.map((row) => ({
    names: String(row.name_value || '').split('\n'),
    notBefore: row.not_before || null,
  }));
};

// Hostnames certified for a domain, and any other domains that shared a certificate with it
export const certificates = async (ctx, domain) => {
  let rows = null;
  for (const [name, lookup] of [
    ['certspotter', certSpotter],
    ['crt.sh', crtSh],
  ]) {
    try {
      rows = await lookup(ctx, domain);
      break;
    } catch (error) {
      ctx.noteError(name, error);
      if (error.code === 'BUDGET') break;
    }
  }
  if (!rows) return null;

  const hosts = new Set();
  const siblings = new Set();
  let firstIssued = null;
  for (const row of rows) {
    const names = row.names.map((name) => cleanHost(name).replace(/^\*\./, '')).filter(Boolean);
    const domains = uniq(names.map(registrableDomain));
    for (const name of names) {
      if (registrableDomain(name) === domain) hosts.add(name);
    }
    // Only certificates covering a few domains count; CDNs bundle hundreds of strangers
    if (domains.length > 1 && domains.length <= 12) {
      for (const other of domains) if (other !== domain) siblings.add(other);
    }
    if (row.notBefore && (!firstIssued || row.notBefore < firstIssued)) firstIssued = row.notBefore;
  }
  return {
    count: rows.length,
    firstIssued,
    hosts: [...hosts].sort().slice(0, 100),
    siblings: [...siblings].sort().slice(0, 100),
  };
};
