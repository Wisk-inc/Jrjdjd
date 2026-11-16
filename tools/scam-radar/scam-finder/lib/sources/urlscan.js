// urlscan.io's public scan archive: the richest free index of what suspect pages looked like
// Works without a key (last 30 days, 30 searches a minute); URLSCAN_API_KEY lifts both limits

import { TTL } from '../net.js';
import { cleanHost, registrableDomain, sleep } from '../util.js';

const SEARCH_URL = 'https://urlscan.io/api/v1/search/';
const RESULT_URL = 'https://urlscan.io/api/v1/result/';
const PAGE_SIZE = 100;

const authHeaders = () =>
  process.env.URLSCAN_API_KEY ? { 'api-key': process.env.URLSCAN_API_KEY } : {};

// Quote a value for a search query, escaping what Elasticsearch treats as syntax
export const quote = (value) => `"${String(value).replace(/(["\\])/g, '\\$1')}"`;

// Flatten one search hit into the fields the engine uses
export const normalizeScan = (hit) => {
  const page = hit.page || {};
  const task = hit.task || {};
  const host = cleanHost(page.domain || task.domain || '');
  return {
    id: hit._id || task.uuid,
    time: task.time || null,
    url: page.url || task.url || null,
    submittedUrl: task.url || null,
    host,
    domain: host ? registrableDomain(host) : null,
    ip: page.ip || null,
    asn: page.asn ? Number(String(page.asn).replace(/^AS/i, '')) : null,
    asnName: page.asnname || null,
    country: page.country || null,
    server: page.server || null,
    title: page.title || null,
    status: page.status ? Number(page.status) : null,
    language: page.language || null,
    domainAgeDays: page.apexDomainAgeDays ?? page.domainAgeDays ?? null,
    tlsIssuer: page.tlsIssuer || null,
    tlsAgeDays: page.tlsAgeDays ?? null,
    tags: task.tags || [],
    redirected: page.redirected || null,
    report: hit._id ? `https://urlscan.io/result/${hit._id}/` : null,
    screenshot: hit.screenshot || null,
  };
};

// Wait out a rate limit when the reply says how long, as long as the budget allows it
const backOff = async (ctx, error) => {
  const wait = Number(
    error.headers?.['x-rate-limit-reset-after'] || error.headers?.['retry-after'],
  );
  if (error.status !== 429 || !Number.isFinite(wait) || wait > 65) return false;
  const ms = (wait + 1) * 1000;
  if (ctx.outOfTime(ms + 5000)) return false;
  ctx.limiter.pause(SEARCH_URL, ms);
  await sleep(ms);
  return true;
};

// Run a search, paging until there's nothing left or the caller's limit is reached
export const search = async (ctx, query, { maxResults = 300 } = {}) => {
  const scans = [];
  let total = 0;
  let after = null;
  let windowDays = null;

  while (scans.length < maxResults) {
    const params = new URLSearchParams({ q: query, size: String(Math.min(PAGE_SIZE, maxResults)) });
    if (after) params.set('search_after', after);
    let data;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        data = await ctx.cachedJson(`${SEARCH_URL}?${params}`, {
          headers: authHeaders(),
          ttl: TTL.search,
          timeoutMs: 30000,
          maxBytes: 8 * 1024 * 1024,
        });
        break;
      } catch (error) {
        if (attempt === 0 && (await backOff(ctx, error))) continue;
        const reason =
          error.status === 403 || error.status === 400 ? safeMessage(error) : error.message;
        ctx.noteError('urlscan', reason);
        return { query, scans, total, windowDays, error: reason };
      }
    }
    const hits = data.results || [];
    total = data.total ?? total;
    windowDays = data.search_date_limit_days ?? windowDays;
    for (const hit of hits) scans.push(normalizeScan(hit));
    if (hits.length < PAGE_SIZE || !hits[hits.length - 1].sort) break;
    after = hits[hits.length - 1].sort.join(',');
  }
  return { query, scans: scans.slice(0, maxResults), total, windowDays };
};

// urlscan explains refusals in a JSON message, which is more useful than a status code
const safeMessage = (error) => {
  try {
    return JSON.parse(error.body).message || error.message;
  } catch {
    return error.message;
  }
};

// The full record for one scan: verdicts plus every host, address and file hash it touched
export const result = async (ctx, id) => {
  try {
    const data = await ctx.cachedJson(`${RESULT_URL}${encodeURIComponent(id)}/`, {
      headers: authHeaders(),
      ttl: TTL.rdap,
      timeoutMs: 30000,
      maxBytes: 12 * 1024 * 1024,
    });
    const verdicts = data.verdicts?.overall || {};
    const lists = data.lists || {};
    return {
      id,
      malicious: Boolean(verdicts.malicious),
      score: verdicts.score ?? null,
      categories: verdicts.categories || [],
      brands: (verdicts.brands || []).map((brand) => brand.name || brand).filter(Boolean),
      tags: verdicts.tags || [],
      domains: (lists.domains || []).map(cleanHost),
      ips: lists.ips || [],
      hashes: lists.hashes || [],
      linkDomains: (lists.linkDomains || []).map(cleanHost),
      certificates: (lists.certificates || []).map((cert) => ({
        subject: cert.subjectName,
        issuer: cert.issuer,
        validFrom: cert.validFrom ? new Date(cert.validFrom * 1000).toISOString() : null,
      })),
    };
  } catch (error) {
    ctx.noteError('urlscan', error);
    return null;
  }
};
