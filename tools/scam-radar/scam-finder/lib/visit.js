// One careful visit to a suspect site: the front door first, then a known deep link
// Shared by investigations (is this sibling still up?) and Radar (what changed since last time?)

import { crawlPage, rootFingerprint } from './page.js';

// Pages that mean a site has been dealt with, and by whom
const TAKEDOWN_PAGES = [
  [
    'blocked',
    'Flagged as phishing by its host',
    /suspected phishing site|reported for potential phishing|deceptive site ahead|this (?:site|page|link) has been (?:blocked|flagged|disabled) (?:for|due to) (?:phishing|abuse|violat)/i,
  ],
  [
    'seized',
    'Seized by law enforcement',
    /this (?:domain|website|site)(?: name)? has been seized|seized by (?:the )?(?:fbi|europol|department of justice|national crime agency|police)/i,
  ],
  [
    'suspended',
    'Suspended by its hosting provider',
    /account (?:has been )?suspended|this (?:site|website|account|domain) (?:has been|is) suspended|suspendedpage\.cgi|website suspended|service suspended|deployment (?:has been )?disabled/i,
  ],
  [
    'parked',
    'Parked or put up for sale',
    /this domain (?:is|may be) for sale|buy this domain|domain (?:is )?parked|parked (?:free|domain)|sedoparking|parkingcrew|bodis\.com|hugedomains\.com|afternic|dan\.com\/buy-domain/i,
  ],
];

// Recognise a takedown or parking page from its title and opening text
export const takedownPage = (page) => {
  if (!page) return null;
  const sample = `${page.title || ''} \n ${(page.text || '').slice(0, 1200)} \n ${(page.rawHtml || '').slice(0, 3000)}`;
  for (const [kind, label, pattern] of TAKEDOWN_PAGES) {
    const match = sample.match(pattern);
    if (match) return { kind, label, evidence: match[0].slice(0, 80) };
  }
  return null;
};

// When the link we fetched was the front page itself, describe it the way rootFingerprint would
export const rootFromPage = (page) => {
  const body = (page.rawHtml || '').trim();
  return {
    status: page.status,
    contentType: page.contentType,
    length: page.bodyLength,
    sample: page.stages.length === 1 && body.length <= 200 ? body : null,
    sha256: page.bodySha256,
    redirectedTo: page.finalUrl !== page.requestedUrl ? page.finalUrl : null,
  };
};

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

// A path nobody has ever linked to, in the style these kits use themselves
const madeUpPath = () => {
  let segment = '';
  for (let i = 0; i < 8; i += 1) segment += LETTERS[Math.floor(Math.random() * LETTERS.length)];
  return `/${segment}/`;
};

// Some kits answer any path with whatever they are promoting today. Once a site is
// confirmed as one of those, ask for a made-up path to read its current lure
export const revealLure = async (ctx, profile, kits, options = {}) => {
  if (profile.page?.title || !kits.some((kit) => kit.lureOnAnyPath)) return false;
  try {
    profile.page = await crawlPage(ctx, `https://${profile.domain}${madeUpPath()}`, {
      maxStages: 2,
      timeoutMs: 9000,
      ...options,
    });
    return true;
  } catch {
    return false;
  }
};

// Visit a site. Returns what the front door said, the page behind a deep link if we have
// one, and whether anything answered at all
export const visitSite = async (
  ctx,
  { domain, sampleUrl, userAgent, timeoutMs = 9000, maxBytes, reserveMs = 6000 },
) => {
  const sample = (sampleUrl || `https://${domain}/`).split('#')[0];
  let origin;
  try {
    origin = new URL(sample).origin;
  } catch {
    origin = `https://${domain}`;
  }
  const options = { userAgent, maxStages: 2, timeoutMs, ...(maxBytes ? { maxBytes } : {}) };
  const deepLink = sample.replace(/\/$/, '') !== origin;
  const visit = { root: null, page: null, live: null, checkedUrl: sample };
  try {
    if (deepLink) {
      // The front door first: kits answer there with a tell-tale stub, whatever the link
      visit.root = await rootFingerprint(ctx, origin, options);
    } else {
      visit.page = await crawlPage(ctx, `${origin}/`, options);
      visit.root = rootFromPage(visit.page);
    }
  } catch (error) {
    visit.live = {
      ok: false,
      error: error.message,
      code: error.code || null,
      checkedUrl: `${origin}/`,
    };
    return visit;
  }
  if (deepLink && !ctx.outOfTime(reserveMs)) {
    try {
      visit.page = await crawlPage(ctx, sample, options);
    } catch {
      // The front door answered, so the site is up even if this old link is dead
    }
  }
  visit.live = { ok: true, status: visit.page?.status ?? visit.root?.status, checkedUrl: sample };
  visit.takedown = takedownPage(visit.page);
  return visit;
};
