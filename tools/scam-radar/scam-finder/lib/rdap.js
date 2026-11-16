// Domain registration facts over RDAP: registrar, key dates, nameservers and where to report abuse
// Registrant names, emails and addresses are deliberately dropped: this maps infrastructure, not people

import { TTL } from './net.js';
import { cleanHost, daysBetween, tldOf } from './util.js';

const BOOTSTRAP_URL = 'https://data.iana.org/rdap/dns.json';
const FALLBACK_BASE = 'https://rdap.org/';

let bootstrap = null;

// IANA's table of which RDAP server answers for which TLD
const loadBootstrap = async (ctx) => {
  if (bootstrap) return bootstrap;
  const table = new Map();
  try {
    const data = await ctx.cachedJson(BOOTSTRAP_URL, {
      ttl: TTL.static,
      maxBytes: 4 * 1024 * 1024,
    });
    for (const [tlds, urls] of data.services || []) {
      const base = urls.find((url) => url.startsWith('https://')) || urls[0];
      if (base) for (const tld of tlds) table.set(tld.toLowerCase(), base);
    }
    bootstrap = table;
  } catch (error) {
    ctx.noteError('rdap', error);
  }
  return table;
};

// Pull one field out of a jCard, which is an array of [name, params, type, value] rows
const vcardField = (entity, field) => {
  const row = (entity?.vcardArray?.[1] || []).find((entry) => entry[0] === field);
  if (!row) return null;
  const value = row[3];
  return Array.isArray(value) ? value.filter(Boolean).join(' ').trim() || null : value || null;
};

const vcardCountry = (entity) => {
  const row = (entity?.vcardArray?.[1] || []).find((entry) => entry[0] === 'adr');
  if (!row) return null;
  const value = Array.isArray(row[3]) ? row[3][6] : null;
  return row[1]?.cc || (typeof value === 'string' && value ? value : null);
};

const findEntity = (entities, role) => {
  for (const entity of entities || []) {
    if ((entity.roles || []).includes(role)) return entity;
    const nested = findEntity(entity.entities, role);
    if (nested) return nested;
  }
  return null;
};

const eventDate = (events, action) =>
  (events || []).find((event) => event.eventAction === action)?.eventDate || null;

// Boil an RDAP reply down to the handful of facts used for scoring and linking
export const parseRdap = (data, now = new Date()) => {
  const registrar = findEntity(data.entities, 'registrar');
  const abuse = findEntity(data.entities, 'abuse');
  const registrant = findEntity(data.entities, 'registrant');
  const created = eventDate(data.events, 'registration');
  const registrarId = (registrar?.publicIds || []).find((id) => /iana/i.test(id.type || ''));
  return {
    registrar: vcardField(registrar, 'fn') || registrar?.handle || null,
    registrarId: registrarId?.identifier || null,
    created,
    updated: eventDate(data.events, 'last changed'),
    expires: eventDate(data.events, 'expiration'),
    ageDays: created ? daysBetween(created, now) : null,
    statuses: data.status || [],
    nameservers: (data.nameservers || [])
      .map((ns) => cleanHost(ns.ldhName))
      .filter(Boolean)
      .sort(),
    abuseEmail: vcardField(abuse, 'email'),
    // Organisation and country only, and only when the registry publishes them
    registrantOrg: vcardField(registrant, 'org'),
    registrantCountry: vcardCountry(registrant),
    dnssec: Boolean(data.secureDNS?.delegationSigned),
  };
};

// Registration record for a domain, or a short reason when there isn't one to be had
export const lookupRdap = async (ctx, domain) => {
  const name = cleanHost(domain);
  const table = await loadBootstrap(ctx);
  const bases = [table.get(tldOf(name)), FALLBACK_BASE].filter(Boolean);
  let lastError = null;
  for (const base of bases) {
    try {
      const data = await ctx.cachedJson(`${base.replace(/\/?$/, '/')}domain/${name}`, {
        headers: { accept: 'application/rdap+json, application/json' },
        ttl: TTL.rdap,
        timeoutMs: 12000,
        maxBytes: 512 * 1024,
      });
      return parseRdap(data);
    } catch (error) {
      lastError = error;
      if (error.code === 'BUDGET') break;
      // Only the registry's own server can say for sure that a name doesn't exist
      if (error.status === 404 && base !== FALLBACK_BASE) return { notRegistered: true };
    }
  }
  // A 404 from the fallback usually means the TLD has no RDAP service at all
  if (lastError?.status !== 404) ctx.noteError('rdap', lastError);
  return { unavailable: true };
};
