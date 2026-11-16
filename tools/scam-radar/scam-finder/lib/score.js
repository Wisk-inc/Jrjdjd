// Turns the evidence on a domain into a 0-100 risk score, with every reason kept alongside it
// The score ranks what to look at first. It is not a verdict, and the signals say why

import { findingWeight } from './analyzer.js';
import { isWellKnown, tldRisk } from './heuristics.js';
import { hostingPlatform } from './util.js';

export const LEVELS = [
  { id: 'critical', min: 85, label: 'Critical' },
  { id: 'high', min: 65, label: 'High' },
  { id: 'medium', min: 40, label: 'Medium' },
  { id: 'low', min: 0, label: 'Low' },
];

export const levelFor = (score) => LEVELS.find((level) => score >= level.min).id;

// How much a link to an already-suspect site counts, by the kind of link
export const LINK_WEIGHTS = {
  kit: 0.65,
  radar: 0.65,
  filename: 0.6,
  hash: 0.65,
  title: 0.5,
  tracker: 0.6,
  contact: 0.6,
  certificate: 0.5,
  redirect: 0.4,
  'loads-from': 0.3,
  ip: 0.3,
  mentions: 0.25,
  query: 0.2,
  keyword: 0.15,
};

export const LINK_LABELS = {
  kit: 'Runs the same scam kit',
  radar: 'Confirmed by Radar as running the same scam kit',
  filename: 'Serves the same kit file',
  hash: 'Serves a byte-identical file',
  title: 'Shows the same page title',
  tracker: 'Uses the same tracking ID',
  contact: 'Uses the same contact or wallet',
  certificate: 'Shares a TLS certificate',
  redirect: 'In the same redirect chain',
  'loads-from': 'Loads content from it',
  ip: 'Hosted on the same dedicated server',
  mentions: 'Contacted by the same scanned page',
  query: 'Matched a hunt query',
  keyword: 'Matched a hunt keyword',
};

const ageSignal = (ageDays) => {
  if (ageDays === null || ageDays === undefined || ageDays < 0) return null;
  if (ageDays < 30) return [0.4, `Registered ${ageDays} day${ageDays === 1 ? '' : 's'} ago`];
  if (ageDays < 90) return [0.3, `Registered ${ageDays} days ago`];
  if (ageDays < 180) return [0.15, `Registered ${Math.round(ageDays / 30)} months ago`];
  return null;
};

// Combine independent signals so several weak ones add up without ever passing 100
const combine = (signals) => {
  const miss = signals.reduce((product, signal) => product * (1 - signal.weight), 1);
  return Math.round(100 * (1 - miss));
};

// Score one domain profile; `ageDays` falls back to the age seen at scan time
export const scoreProfile = (profile) => {
  const signals = [];
  const add = (id, weight, label, detail) => {
    if (weight > 0)
      signals.push({ id, weight: Number(weight.toFixed(2)), label, ...(detail ? { detail } : {}) });
  };

  if (profile.wellKnown ?? isWellKnown(profile.domain)) {
    return {
      score: 0,
      level: 'low',
      benign: true,
      signals: [{ id: 'well-known', weight: 0, label: 'Well-known legitimate service' }],
    };
  }

  const page = profile.page || {};
  const behaviour = page.behaviour || {};
  const brands = (profile.brands || []).filter((brand) => !brand.official);
  const lure = (profile.lures || [])[0];
  const onPlatform = Boolean(hostingPlatform(profile.domain));

  // Someone already reported it
  const listings = profile.blocklists || [];
  if (listings.length) {
    add(
      'blocklist',
      listings.length > 1 ? 0.95 : 0.9,
      'Listed on public scam blocklists',
      listings.map((hit) => hit.name).join(', '),
    );
  }
  for (const kit of profile.kits || []) {
    add(
      `kit:${kit.id}`,
      kit.score > 2 ? 0.92 : 0.85,
      `Matches a known scam kit: ${kit.name}`,
      kit.evidence.join('; '),
    );
  }
  if (profile.verdict?.malicious) add('scan-verdict', 0.8, 'Flagged malicious by urlscan.io');
  if ((profile.scans?.tags || []).some((tag) => /phish|scam|malicious/i.test(tag))) {
    add(
      'reported',
      0.5,
      'Submitted to urlscan.io by a phishing-report service',
      profile.scans.tags.join(', '),
    );
  }

  // What the page says and whose name it borrows
  const baitBrand = brands.find((brand) => brand.inTitle || brand.inDomain);
  if (lure && baitBrand) {
    add(
      'brand-bait',
      0.55,
      `${lure.label} in the name of ${baitBrand.name}`,
      `"${lure.cues[0]}" on a site that is not ${baitBrand.name}'s`,
    );
  } else if (lure) {
    add(
      `lure:${lure.id}`,
      0.3 * lure.strength,
      lure.label,
      lure.cues.map((cue) => `"${cue}"`).join(', '),
    );
  }
  const lookalike = brands.find((brand) => brand.inDomain);
  if (lookalike) add('brand-in-domain', 0.5, `Domain name borrows ${lookalike.name}'s name`);
  const namedBrand = brands.find((brand) => (brand.inTitle || brand.inText) && !brand.common);
  if (namedBrand && page.forms?.passwordFields) {
    add('brand-login', 0.6, `Password form on a page that names ${namedBrand.name}`);
  }

  // How the page behaves
  if (behaviour.deviceCloaking) {
    add(
      'cloaking',
      0.5,
      'Hides from desktop browsers',
      'Obfuscated script checks the device and sends desktops to a dead page',
    );
  }
  if (page.og?.spoofedHost && isWellKnown(page.og.spoofedHost)) {
    add('preview-spoof', 0.45, `Link preview pretends to be ${page.og.spoofedHost}`);
  }
  if (behaviour.devtoolsTrap)
    add('devtools-trap', 0.25, 'Tries to block inspection with developer tools');
  if (behaviour.backButtonTrap) add('back-trap', 0.2, 'Hijacks the back button');
  if (
    page.forms?.passwordFields &&
    page.forms.actionHosts?.some((host) => !host.endsWith(profile.domain))
  ) {
    add(
      'offsite-form',
      0.35,
      'Password form sends data to a different site',
      page.forms.actionHosts.join(', '),
    );
  }
  if (page.forms?.cardFields && !namedBrand) add('card-form', 0.2, 'Asks for payment card details');
  const stub =
    profile.root && profile.root.length < 200 && page.bodyLength > 500 && page.status === 200;
  if (stub)
    add(
      'stub-front-page',
      0.2,
      'Front page is an empty stub while deep links serve content',
      profile.root.sample || undefined,
    );

  // What its code is built to do (the four most serious findings)
  for (const finding of (profile.findings || []).slice(0, 4)) {
    add(
      `code:${finding.id}`,
      findingWeight(finding),
      `Code: ${finding.label}`,
      `${finding.hidden ? 'Hidden in encoded script: ' : ''}${finding.evidence}`,
    );
  }

  // What the address looks like
  const age = onPlatform
    ? null
    : ageSignal(profile.registration?.ageDays ?? profile.scans?.ageDays);
  if (age) add('new-domain', age[0], age[1]);
  if (tldRisk(profile.domain))
    add(
      'risky-tld',
      0.15,
      `Uses a cheap, heavily abused TLD (.${profile.domain.split('.').pop()})`,
    );
  if (profile.lexical?.randomLooking)
    add('random-name', 0.2, 'Domain name looks machine-generated');
  if (profile.lexical?.punycode)
    add('punycode', 0.25, 'Domain uses look-alike (punycode) characters');
  const shape = profile.urlShape;
  if (shape?.shareSource) {
    const where =
      { wa: 'WhatsApp', ms: 'Messenger', fb: 'Facebook', tg: 'Telegram', ig: 'Instagram' }[
        shape.shareSource
      ] || shape.shareSource;
    add('share-tag', 0.25, `Link is tagged as spread through ${where}`);
  }
  if (shape?.longToken && shape?.timestamp)
    add('token-link', 0.2, 'Link carries a long tracking token and a timestamp');
  if (shape?.deepSubdomain) add('deep-subdomain', 0.15, 'Buried under several subdomain levels');

  // Links to other suspect sites, set by the investigation once the graph is known
  for (const link of profile.association || [])
    add(`linked:${link.type}`, link.weight, link.label, link.detail);
  if (profile.cohort)
    add(
      'name-batch',
      0.2,
      `One of ${profile.cohort.size} look-alike names (${profile.cohort.shape})`,
    );
  if (profile.batch)
    add(
      'bulk-registration',
      0.25,
      `Registered in a batch of ${profile.batch.size} on ${profile.batch.date}`,
    );

  let score = combine(signals);
  const mitigations = [];
  const years = (profile.registration?.ageDays ?? profile.scans?.ageDays ?? 0) / 365;
  if (!onPlatform && years >= 3 && !listings.length && !(profile.kits || []).length) {
    score = Math.round(score * 0.6);
    mitigations.push(`Domain has been registered for ${Math.floor(years)} years`);
  }
  if (brands.length === 0 && (profile.brands || []).some((brand) => brand.official)) {
    score = Math.round(score * 0.3);
    mitigations.push("This is the brand's own domain");
  }

  signals.sort((a, b) => b.weight - a.weight);
  return { score, level: levelFor(score), signals, ...(mitigations.length ? { mitigations } : {}) };
};
