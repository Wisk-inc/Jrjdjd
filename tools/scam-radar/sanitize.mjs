// What may leave Scam Finder for a public page, in one place. The export (Radar's published data)
// and the API (a check somebody asks for) both pass their results through here.
//
// Kept: what Radar and Scam Finder say in their own words (kits, brands, kinds of lure, the
// reasons behind a score, hosting, registration, dates), and a scam page's title with phone
// numbers, emails, links and handles removed.
// Dropped: page text, descriptions, contacts, wallets, tracking IDs and code snippets. A contact
// on a scam page is often someone else's hijacked account, and a code snippet can carry a live
// bot token. Sites that share a contact or tracker are still linked, under a reference number.
import crypto from 'node:crypto';

// Values are only ever shown as text, so this is tidying, not escaping: no markup, no control characters
export const clean = (text, max = 60) =>
  String(text ?? '').replace(/[<>`\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim().slice(0, max);

// A scam page's title, made safe to repeat
export const cleanTitle = (title) => clean(String(title ?? '')
  .replace(/\b(?:https?:\/\/|www\.)\S+/gi, ' ')
  .replace(/\S+@\S+\.\S+/g, ' ')
  .replace(/(?:^|\s)@\w{3,}/g, ' ')
  .replace(/\+?\d[\d\s().-]{5,}\d/g, (run) => (run.replace(/\D/g, '').length >= 7 ? ' ' : run))
  .replace(/\b([a-z0-9-]{2,})\.([a-z]{2,})\b/gi, '$1[.]$2'), 90) || null;

export const defang = (name) => String(name).toLowerCase().replace(/[^a-z0-9.-]/g, '').replace(/\./g, '[.]');
export const hashOf = (name) => crypto.createHash('sha256').update(String(name).toLowerCase()).digest('hex').slice(0, 12);

// A URL without its query string or fragment, which is where tokens and personal details ride
const barePath = (value) => {
  try {
    const url = new URL(value);
    return clean(`${url.origin}${url.pathname}`, 160);
  } catch {
    return null;
  }
};
const hostsOnly = (list, max = 12) =>
  [...new Set((list || []).map((host) => clean(host, 80).toLowerCase()).filter((host) => /^[a-z0-9.-]+$/.test(host)))].slice(0, max);

// One site's record, in place. Works on Radar's map records and on investigation results.
export const sanitizeDomain = (domain) => {
  domain.title = cleanTitle(domain.title);
  domain.urls = (domain.urls || []).map(barePath).filter(Boolean).slice(0, 3);
  if (domain.risk) {
    domain.risk.signals = (domain.risk.signals || []).map(({ id, weight, label }) => ({ id, weight, label: clean(label, 140) }));
    if (domain.risk.mitigations) domain.risk.mitigations = domain.risk.mitigations.map((text) => clean(text, 140));
  }
  domain.findings = (domain.findings || []).map(({ id, label, severity, category, hidden }) =>
    ({ id, label: clean(label, 120), severity, category, hidden: Boolean(hidden), evidence: '' }));
  domain.kits = (domain.kits || []).map(({ id, name, category, description }) =>
    ({ id, name: clean(name, 80), category, description: clean(description, 240), evidence: [] }));
  domain.lures = (domain.lures || []).map(({ id, label }) => ({ id, label: clean(label, 60), cues: [] }));
  domain.foundBy = (domain.foundBy || []).map(({ type, value, depth }) => ({
    type, depth, value: type === 'title' ? cleanTitle(value) || 'same page title' : clean(value, 100) }));
  if (domain.live?.checkedUrl) domain.live = { ...domain.live, checkedUrl: barePath(domain.live.checkedUrl) };
  if (domain.live?.error) domain.live = { ...domain.live, error: clean(domain.live.error, 120) };
  if (domain.scans) {
    domain.scans = {
      ...domain.scans,
      titles: (domain.scans.titles || []).map(({ title, count }) => ({ title: cleanTitle(title), count })).filter((item) => item.title),
      urls: (domain.scans.urls || []).map(barePath).filter(Boolean),
      reports: (domain.scans.reports || []).filter((report) => typeof report === 'string').map(barePath).filter(Boolean),
    };
  }
  if (domain.root) domain.root = { ...(typeof domain.root.length === 'number' ? { length: domain.root.length } : {}), sample: null };
  domain.seo = null;
  const page = domain.page;
  if (page) {
    const kinds = {};
    for (const item of page.contacts || []) kinds[clean(item.kind, 20)] = (kinds[clean(item.kind, 20)] || 0) + 1;
    domain.page = {
      status: page.status,
      finalUrl: page.finalUrl ? barePath(page.finalUrl) : undefined,
      bodyLength: page.bodyLength,
      description: null,
      spoofedHost: clean(page.spoofedHost || page.og?.spoofedHost, 80) || null,
      og: page.og?.spoofedHost ? { spoofedHost: clean(page.og.spoofedHost, 80) } : undefined,
      forms: page.forms ? { passwordFields: page.forms.passwordFields || 0, cardFields: page.forms.cardFields || 0,
        actionHosts: hostsOnly(page.forms.actionHosts, 6) } : undefined,
      behaviour: page.behaviour ? Object.fromEntries(Object.entries(page.behaviour).filter(([, v]) => typeof v === 'boolean')) : undefined,
      externalHosts: page.externalHosts ? hostsOnly(page.externalHosts) : undefined,
      resources: (page.resources || []).slice(0, 12).map(({ kind, host, path }) =>
        ({ kind: clean(kind, 20), host: clean(host, 80), path: clean(String(path || '').split('?')[0], 120) })),
      resourceCount: page.resourceCount,
      structure: page.structure,
      contacts: [],
      contactsWithheld: kinds,
      trackers: [],
      trackersWithheld: (page.trackers || []).length,
      stages: [],
    };
  }
  if (domain.track?.events) {
    domain.track.events = domain.track.events.map(({ at, type, text }) => ({ at, type, text: clean(text, 120), detail: null }));
  }
  return domain;
};

export const sanitizeCampaigns = (campaigns) => {
  for (const campaign of campaigns || []) {
    campaign.title = cleanTitle(campaign.title);
    campaign.label = campaign.title || clean(campaign.kit, 80) || 'Same kit';
    if (String(campaign.key).startsWith('title:')) campaign.key = `title:${hashOf(campaign.key)}`;
  }
  return campaigns;
};

export const sanitizeLinks = (links) => {
  for (const link of links || []) {
    if (link.kind === 'tracker' || link.kind === 'contact') {
      const tag = hashOf(link.key).slice(0, 6);
      link.id = `${link.kind}:${tag}`;
      link.key = tag;
      link.label = `${link.kindLabel} (ref ${tag})`;
    } else {
      link.label = clean(link.label, 140);
      link.key = clean(link.key, 140);
    }
  }
  return links;
};
