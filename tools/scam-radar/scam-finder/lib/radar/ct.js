// Certificate Transparency: every TLS certificate issued is published in public logs, with
// the hostnames it covers. Reading the newest entries is a live feed of sites coming online
//
// Modern logs serve their entries as static "tiles" of 256 certificates each, which makes
// this cheap: one small download yields a few hundred hostnames

import { TTL } from '../net.js';

const LOG_LIST = 'https://www.gstatic.com/ct/log_list/v3/log_list.json';
const TILE_SIZE = 256;

// The certificate extension that lists hostnames (subjectAltName, OID 2.5.29.17), as bytes
const SAN_OID = Buffer.from([0x06, 0x03, 0x55, 0x1d, 0x11]);

// Read a DER length at `offset`, returning [length, offset of the content]
const derLength = (der, offset) => {
  const first = der[offset];
  if (first < 0x80) return [first, offset + 1];
  const count = first & 0x7f;
  let length = 0;
  for (let i = 0; i < count; i += 1) length = length * 256 + der[offset + 1 + i];
  return [length, offset + 1 + count];
};

// Hostnames in a certificate, found by jumping straight to the one extension that holds
// them. About ten times faster than parsing the whole certificate, and works on the
// "to be signed" bodies that pre-certificates carry too
export const certificateNames = (der) => {
  const names = [];
  const at = der.indexOf(SAN_OID);
  if (at < 0) return names;
  let offset = at + SAN_OID.length;
  if (der[offset] === 0x01) offset += 3; // an optional "critical" flag
  if (der[offset] !== 0x04) return names;
  const [, inner] = derLength(der, offset + 1);
  if (der[inner] !== 0x30) return names;
  const [length, start] = derLength(der, inner + 1);
  const end = Math.min(der.length, start + length);
  let cursor = start;
  while (cursor < end) {
    const tag = der[cursor];
    const [size, content] = derLength(der, cursor + 1);
    // 0x82 marks a DNS name; the other tags are IP addresses, emails and the like
    if (tag === 0x82) names.push(der.toString('latin1', content, content + size).toLowerCase());
    cursor = content + size;
  }
  return names;
};

// Every hostname in one data tile
export const tileNames = (tile) => {
  const names = [];
  let offset = 0;
  while (offset + 12 <= tile.length) {
    offset += 8; // timestamp
    const type = tile.readUInt16BE(offset);
    offset += 2;
    if (type === 1) offset += 32; // pre-certificates start with the issuer's key hash
    const size = tile.readUIntBE(offset, 3);
    offset += 3;
    for (const name of certificateNames(tile.subarray(offset, offset + size))) names.push(name);
    offset += size;
    offset += 2 + tile.readUInt16BE(offset); // extensions
    if (type === 1) offset += 3 + tile.readUIntBE(offset, 3); // the pre-certificate itself
    offset += 2 + tile.readUInt16BE(offset); // chain fingerprints
  }
  return names;
};

// Where tile number n lives: 1234067 becomes x001/x234/067
export const tilePath = (index) => {
  const parts = [];
  let rest = index;
  do {
    parts.unshift(String(rest % 1000).padStart(3, '0'));
    rest = Math.floor(rest / 1000);
  } while (rest > 0);
  return parts.map((part, position) => (position < parts.length - 1 ? `x${part}` : part)).join('/');
};

// Tile-serving logs that are accepting certificates right now, one or two per operator
export const activeLogs = async (ctx, { perOperator = 1, now = Date.now() } = {}) => {
  const list = await ctx.cachedJson(LOG_LIST, { ttl: TTL.rdap, maxBytes: 4 * 1024 * 1024 });
  const horizon = now + 100 * 86400000;
  const logs = [];
  for (const operator of list.operators || []) {
    const usable = (operator.tiled_logs || []).filter((log) => {
      const span = log.temporal_interval || {};
      const starts = Date.parse(span.start_inclusive);
      const ends = Date.parse(span.end_exclusive);
      // Certificates are filed by expiry date, so the busy logs cover the next few months
      return log.state?.usable && starts <= horizon && ends > now;
    });
    usable.sort(
      (a, b) =>
        Date.parse(b.temporal_interval.start_inclusive) -
        Date.parse(a.temporal_interval.start_inclusive),
    );
    for (const log of usable.slice(0, perOperator)) {
      logs.push({
        name: log.description,
        operator: operator.name,
        url: log.monitoring_url.replace(/\/?$/, '/'),
      });
    }
  }
  return logs;
};

// How many entries a log holds, from its signed checkpoint
export const logSize = async (ctx, log) => {
  const response = await ctx.fetch(`${log.url}checkpoint`, {
    timeoutMs: 15000,
    maxBytes: 64 * 1024,
  });
  const size = Number(response.text.split('\n')[1]);
  if (!response.ok || !Number.isFinite(size))
    throw new Error(`Unreadable checkpoint from ${log.name}`);
  return size;
};

// Read up to `tiles` new tiles from one log, starting where the last read stopped.
// The first read starts `backfill` tiles before the end, not at entry zero of a billion
export const readLog = async (ctx, log, { cursor, tiles = 20, backfill = 20 } = {}) => {
  const size = await logSize(ctx, log);
  const complete = Math.floor(size / TILE_SIZE);
  let next = cursor ?? Math.max(0, complete - backfill);
  const wanted = [];
  while (next < complete && wanted.length < tiles) {
    wanted.push(next);
    next += 1;
  }
  const names = [];
  let failed = 0;
  await Promise.all(
    wanted.map(async (index) => {
      try {
        const response = await ctx.fetch(`${log.url}tile/data/${tilePath(index)}`, {
          timeoutMs: 30000,
          maxBytes: 16 * 1024 * 1024,
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        for (const name of tileNames(response.bytes)) names.push(name);
      } catch (error) {
        failed += 1;
        ctx.noteError(`ct:${log.name}`, error);
      }
    }),
  );
  return { names, cursor: next, tiles: wanted.length - failed, behind: complete - next, size };
};
