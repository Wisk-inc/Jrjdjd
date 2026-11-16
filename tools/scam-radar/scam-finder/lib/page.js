// Fetches a suspect page as inert text and pulls out the fingerprints that link sites together
// Nothing is rendered or executed: scripts are only read, and redirects are followed by hand

import { MOBILE_UA } from './net.js';
import { resolve } from './dns.js';
import {
  cleanHost,
  isIp,
  isLocalName,
  isPrivateIp,
  registrableDomain,
  sha256,
  uniq,
} from './util.js';

const MAX_HTML = 600 * 1024;
const MAX_REDIRECTS = 5;
const MAX_STAGES = 3;

const blocked = (host, why) => {
  const error = new Error(`Refusing to fetch ${host}: ${why}`);
  error.code = 'BLOCKED';
  return error;
};

// Scam pages can redirect anywhere, so every hop is checked before it's requested
export const assertPublicHost = async (ctx, hostname) => {
  const host = cleanHost(hostname);
  if (isLocalName(host)) throw blocked(host, 'local hostname');
  if (isIp(host)) {
    if (isPrivateIp(host)) throw blocked(host, 'private address');
    return;
  }
  const v4 = await resolve(ctx, host, 'A');
  if (v4 === null) throw blocked(host, 'address could not be verified');
  let addresses = v4.answers;
  if (!addresses.length) addresses = (await resolve(ctx, host, 'AAAA'))?.answers || [];
  if (!addresses.length) throw blocked(host, 'does not resolve');
  if (addresses.some(isPrivateIp)) throw blocked(host, 'resolves to a private address');
};

// GET a page, following HTTP redirects ourselves so the whole chain is on record
export const fetchPage = async (ctx, url, opts = {}) => {
  const chain = [];
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const target = new URL(current);
    if (!['http:', 'https:'].includes(target.protocol)) {
      throw blocked(target.protocol, 'not a web address');
    }
    await assertPublicHost(ctx, target.hostname);
    const response = await ctx.fetch(current, {
      headers: {
        'user-agent': opts.userAgent || MOBILE_UA,
        accept: 'text/html,application/xhtml+xml,*/*;q=0.8',
        'accept-language': opts.language || 'en-US,en;q=0.9',
      },
      redirect: 'manual',
      timeoutMs: opts.timeoutMs || 12000,
      maxBytes: opts.maxBytes || MAX_HTML,
    });
    const location = response.headers.location;
    if (response.status >= 300 && response.status < 400 && location) {
      let next;
      try {
        next = new URL(location, current).href;
      } catch {
        throw new Error(`Unparseable redirect from ${target.host}`);
      }
      chain.push({ url: current, status: response.status, location: next });
      current = next;
      continue;
    }
    return {
      requestedUrl: url,
      finalUrl: current,
      status: response.status,
      headers: response.headers,
      chain,
      bytes: response.bytes,
      html: response.text,
      truncated: response.truncated,
    };
  }
  throw new Error(`More than ${MAX_REDIRECTS} redirects from ${new URL(url).host}`);
};

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

// Decode the handful of HTML entities that turn up in titles and attributes
export const decodeEntities = (text) =>
  String(text || '').replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,6});/gi, (whole, body) => {
    const key = body.toLowerCase();
    if (key.startsWith('#x')) return codePoint(parseInt(key.slice(2), 16), whole);
    if (key.startsWith('#')) return codePoint(parseInt(key.slice(1), 10), whole);
    return ENTITIES[key] ?? whole;
  });

const codePoint = (value, fallback) => {
  try {
    return String.fromCodePoint(value);
  } catch {
    return fallback;
  }
};

// Read one attribute out of a raw tag
const attribute = (tag, name) => {
  const match = tag.match(
    new RegExp(`[\\s"']${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, 'i'),
  );
  return match ? decodeEntities(match[1] ?? match[2] ?? match[3] ?? '') : null;
};

const TAGS = /<(script|img|link|iframe|source|video|audio|a|form|input|meta|base)\b[^>]{0,3000}>/gi;

const absolute = (value, base) => {
  if (!value || /^(data|javascript|mailto|tel|sms|blob|about):/i.test(value.trim())) return null;
  try {
    const url = new URL(value.trim(), base);
    return ['http:', 'https:'].includes(url.protocol) ? url : null;
  } catch {
    return null;
  }
};

// Tracking and analytics identifiers: the same ID on two sites means the same operator
const TRACKERS = [
  ['google-analytics', /\bUA-\d{4,10}-\d{1,4}\b/g, 0],
  ['google-analytics', /(?:[?&]id=|['"])(G-[A-Z0-9]{8,12})\b/g, 1],
  ['google-tag-manager', /\bGTM-[A-Z0-9]{5,8}\b/g, 0],
  ['google-ads', /\bAW-\d{8,12}\b/g, 0],
  ['adsense', /\bca-pub-\d{12,18}\b/g, 0],
  ['facebook-pixel', /fbq\(\s*['"]init['"]\s*,\s*['"](\d{12,18})['"]/g, 1],
  ['tiktok-pixel', /ttq\.load\(\s*['"]([A-Z0-9]{15,25})['"]/g, 1],
  ['yandex-metrica', /mc\.yandex\.ru\/watch\/(\d{6,10})/g, 1],
  ['yandex-metrica', /\bym\(\s*(\d{6,10})\s*,/g, 1],
  ['baidu-tongji', /hm\.baidu\.com\/hm\.js\?([a-f0-9]{32})/g, 1],
  ['51la', /LA\.init\(\{\s*id\s*:\s*["']([A-Za-z0-9]{6,24})["']/g, 1],
  ['cnzz', /cnzz\.com\/[a-z_]+\.(?:php|js)\?(?:web_)?id=(\d{6,12})/g, 1],
  ['hotjar', /hjid\s*:\s*(\d{5,9})/g, 1],
  ['clarity', /clarity\.ms\/tag\/([a-z0-9]{8,14})/g, 1],
  ['histats', /Histats\.start\(\s*\d+\s*,\s*(\d{6,9})/g, 1],
  ['statcounter', /sc_project\s*=\s*(\d{6,9})/g, 1],
  // Phishing kits post stolen data to a Telegram bot; keep the bot's public ID, never its token
  ['telegram-bot', /api\.telegram\.org\/bot(\d{6,12}):[A-Za-z0-9_-]{30,40}/g, 1],
];

// Addresses that look like emails but are file names, placeholders or library boilerplate
const NOT_AN_EMAIL =
  /\.(png|jpe?g|gif|webp|svg|css|js|woff2?)$|@(example|domain|email|yourdomain|yoursite|company|sentry|wixpress|test)\.|^(you|your|name|user|username|email|someone|john\.?doe)@/i;

// Contact points and wallets a page asks victims to use
const CONTACTS = [
  ['telegram', /(?:t\.me|telegram\.me)\/(\+?[A-Za-z0-9_]{5,40})\b/g],
  [
    'whatsapp',
    /(?:wa\.me\/|whatsapp\.com\/send\/?\?phone=|whatsapp:\/\/send\?phone=)\+?(\d{7,15})\b/g,
  ],
  ['email', /mailto:([a-z0-9][a-z0-9._%+-]{0,48}@[a-z0-9-]+(?:\.[a-z0-9-]+)+)/gi],
  ['phone', /href\s*=\s*["']tel:(\+?[\d\s().-]{7,22})["']/gi],
  ['bitcoin', /\b(bc1[ac-hj-np-z02-9]{25,59})\b/g],
  ['ethereum', /\b(0x[a-fA-F0-9]{40})\b/g],
  ['tron', /\b(T[1-9A-HJ-NP-Za-km-z]{33})\b/g],
];

// Emails and international phone numbers written out in the visible text
const TEXT_CONTACTS = [
  [
    'email',
    /(?<![\w.+-])([a-z0-9][a-z0-9._%+-]{0,48}@[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,24})(?![\w-])/gi,
  ],
  ['phone', /(?<![\w+])(\+\d{1,3}[\s.-]?\(?\d{2,4}\)?(?:[\s.-]?\d{2,4}){2,4})(?!\d)/g],
];

// One spelling per contact, so the same address or number matches across sites
const tidyContact = (item) => {
  if (item.kind === 'email') {
    const id = item.id.toLowerCase();
    return NOT_AN_EMAIL.test(id) ? null : { kind: 'email', id };
  }
  if (item.kind === 'phone' || item.kind === 'whatsapp') {
    const digits = item.id.replace(/\D/g, '');
    if (digits.length < 8 || digits.length > 15) return null;
    return { kind: item.kind, id: `+${digits}` };
  }
  return item;
};

const collect = (html, patterns, limit = 6) => {
  const found = [];
  for (const [kind, pattern, group = 1] of patterns) {
    for (const match of html.matchAll(pattern)) {
      found.push({ kind, id: match[group] });
      if (found.length >= 60) break;
    }
  }
  const seen = new Set();
  return found
    .filter((item) => {
      const key = `${item.kind}:${item.id}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, limit * patterns.length);
};

// Strings hidden inside atob('...') calls, which is how kits hide what their scripts touch
const decodeAtobStrings = (html) => {
  const decoded = [];
  for (const match of html.matchAll(/atob\(\s*['"]([A-Za-z0-9+/=]{2,400})['"]\s*\)/g)) {
    try {
      decoded.push(Buffer.from(match[1], 'base64').toString('utf8'));
    } catch {
      // Not valid base64, nothing to learn
    }
    if (decoded.length >= 80) break;
  }
  return decoded;
};

// What the page's scripts do, read from source rather than by running them
const scriptBehaviour = (html) => {
  const hidden = decodeAtobStrings(html);
  const hiddenWords = hidden.join(' ').toLowerCase();
  const atobCalls = (html.match(/\batob\s*\(/g) || []).length;
  const readsPlatform =
    /navigator\s*(?:\.|\[\s*['"])\s*(?:platform|webdriver)/i.test(html) ||
    /\b(platform|webdriver)\b/.test(hiddenWords);
  const redirectsInScript =
    /(?<![\w$])(?:(?:top|window|self|parent|document)\.)?location(?:\.href)?\s*=(?!=)|(?<![\w$])location\.(?:replace|assign)\s*\(/.test(
      html,
    );
  return {
    atobCalls,
    hiddenStrings: uniq(hidden).slice(0, 20),
    readsPlatform,
    redirectsInScript,
    deviceCloaking: readsPlatform && redirectsInScript && atobCalls >= 4,
    devtoolsTrap: /\bdebugger\s*;|disable-devtool|devtools-detect/i.test(html),
    evalUse: /\beval\s*\(|new\s+Function\s*\(|document\.write\s*\(\s*unescape/i.test(html),
    backButtonTrap: /history\.pushState[\s\S]{0,600}popstate|onpopstate\s*=/i.test(html),
    whatsappShare: /whatsapp:\/\/send|api\.whatsapp\.com\/send|wa\.me\/\?text=/i.test(html),
    notificationPrompt: /Notification\.requestPermission/i.test(html),
    clipboardWrite: /navigator\.clipboard\.writeText|execCommand\(\s*['"]copy/i.test(html),
    fullscreenLock: /requestFullscreen|webkitRequestFullScreen|mozRequestFullScreen/i.test(html),
  };
};

// Where a page's script sends the browser next, when it says so in a plain string
const scriptRedirects = (html, baseUrl) => {
  const base = new URL(baseUrl);
  const targets = [];
  const assignments =
    /(?<![\w$])(?:(?:top|window|self|parent|document)\.)?location(?:\.href)?\s*=(?!=)\s*(["'`])([^"'`\n]{1,600})\1([^;\n]{0,80})|(?<![\w$])location\.(?:replace|assign)\s*\(\s*(["'`])([^"'`\n]{1,600})\4([^;\n]{0,80})/g;
  for (const match of html.matchAll(assignments)) {
    const literal = match[2] ?? match[5];
    const tail = (match[3] ?? match[6] ?? '').trim();
    // More is being glued on than we can evaluate, so the address we'd build would be wrong
    if (tail.startsWith('+') && !/^\+\s*(window\.|document\.)?location\.search\b/.test(tail))
      continue;
    // Fill in the two placeholders these templates use, and skip anything more dynamic
    const filled = literal.replace(/\$\{\s*Date\.now\(\)\s*\}/g, String(Date.now()));
    if (filled.includes('${')) continue;
    const url = absolute(filled, baseUrl);
    if (!url) continue;
    if (/location\.search/.test(tail) && !url.search) url.search = base.search;
    targets.push(url.href);
  }
  const refresh = html.match(/<meta[^>]{0,200}http-equiv\s*=\s*["']?refresh[^>]{0,400}>/i);
  if (refresh) {
    const content = attribute(refresh[0], 'content') || '';
    const target = absolute(
      content.replace(/^[^;]*;\s*(?:url\s*=)?\s*['"]?/i, '').replace(/['"]$/, ''),
      baseUrl,
    );
    if (target && /;/.test(content)) targets.push(target.href);
  }
  return uniq(targets).slice(0, 4);
};

// Cut out everything between an opening marker and its close, in one linear pass
// (a regex here could be made to crawl by a page with thousands of unclosed tags)
const stripBlocks = (html, open, close) => {
  const lower = html.toLowerCase();
  let out = '';
  let cursor = 0;
  for (;;) {
    const start = lower.indexOf(open, cursor);
    if (start === -1) return out + html.slice(cursor);
    out += `${html.slice(cursor, start)} `;
    const end = lower.indexOf(close, start + open.length);
    if (end === -1) return out;
    cursor = end + close.length;
  }
};

// Visible words on the page, for spotting lures without keeping the whole document
const visibleText = (html) => {
  let text = stripBlocks(html, '<script', '</script');
  text = stripBlocks(text, '<style', '</style');
  text = stripBlocks(text, '<!--', '-->');
  return decodeEntities(text.replace(/<[^>]{0,3000}>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
};

const classifyResource = (tagName, tag, url) => {
  if (tagName === 'script') return 'script';
  if (tagName === 'img') return 'image';
  if (tagName === 'iframe') return 'frame';
  if (tagName === 'link') {
    const rel = (attribute(tag, 'rel') || '').toLowerCase();
    if (rel.includes('icon')) return 'icon';
    if (rel.includes('stylesheet')) return 'style';
    return /\.(css)(\?|$)/i.test(url.pathname) ? 'style' : null;
  }
  return 'media';
};

// A fingerprint of a page's skeleton: its first few hundred tag names, in order.
// Copies of one kit share it even when every word and link on the page differs
export const structureHash = (html) => {
  const tags = [];
  for (const match of html.matchAll(/<([a-z][a-z0-9]{0,15})[\s>/]/gi)) {
    tags.push(match[1].toLowerCase());
    if (tags.length >= 400) break;
  }
  return tags.length >= 8 ? sha256(tags.join(' ')).slice(0, 16) : null;
};

// A fingerprint of what a page says, with numbers blanked so counters and timestamps
// don't register as a change
export const contentHash = (text) => {
  const words = String(text || '')
    .toLowerCase()
    .replace(/\d+/g, '#')
    .replace(/\s+/g, ' ')
    .trim();
  return words.length >= 12 ? sha256(words.slice(0, 6000)).slice(0, 16) : null;
};

// How the page presents itself to search engines
const seoFacts = (html, meta, title, text, linkCounts) => {
  const canonical = html.match(/<link[^>]{0,300}rel\s*=\s*["']?canonical["']?[^>]{0,300}>/i);
  const types = [...html.matchAll(/"@type"\s*:\s*"([A-Za-z]{2,40})"/g)].map((match) => match[1]);
  return {
    titleLength: title ? title.length : 0,
    description: Boolean(meta.description),
    canonical: canonical ? attribute(canonical[0], 'href') : null,
    robots: meta.robots || null,
    hiddenFromSearch: /noindex/i.test(meta.robots || ''),
    headings: (html.match(/<h1[\s>]/gi) || []).length,
    words: text ? text.split(/\s+/).length : 0,
    internalLinks: linkCounts.internal,
    externalLinks: linkCounts.external,
    languages: (html.match(/hreflang\s*=/gi) || []).length,
    structuredData: uniq(types).slice(0, 6),
    mobileReady: Boolean(meta.viewport),
  };
};

// Everything worth knowing about one HTML document
export const extractFingerprint = (html, pageUrl) => {
  const page = new URL(pageUrl);
  const pageDomain = registrableDomain(page.hostname);
  const titleMatch = html.match(/<title[^>]*>([\s\S]{0,600}?)<\/title\s*>/i);
  const meta = {};
  const resources = [];
  const linkHosts = new Set();
  const forms = { count: 0, passwordFields: 0, cardFields: 0, actionHosts: [] };
  const linkCounts = { internal: 0, external: 0 };
  let baseHref = pageUrl;

  for (const match of html.matchAll(TAGS)) {
    const tag = match[0];
    const name = match[1].toLowerCase();
    if (name === 'base') {
      baseHref = absolute(attribute(tag, 'href'), pageUrl)?.href || baseHref;
    } else if (name === 'meta') {
      const key = (attribute(tag, 'property') || attribute(tag, 'name') || '').toLowerCase();
      const content = attribute(tag, 'content');
      if (key && content && !(key in meta)) meta[key] = content.slice(0, 600);
    } else if (name === 'a') {
      const url = absolute(attribute(tag, 'href'), baseHref);
      if (url) {
        linkHosts.add(cleanHost(url.hostname));
        linkCounts[registrableDomain(url.hostname) === pageDomain ? 'internal' : 'external'] += 1;
      }
    } else if (name === 'form') {
      forms.count += 1;
      const url = absolute(attribute(tag, 'action'), baseHref);
      if (url) forms.actionHosts.push(cleanHost(url.hostname));
    } else if (name === 'input') {
      const type = (attribute(tag, 'type') || '').toLowerCase();
      const field = `${attribute(tag, 'name') || ''} ${attribute(tag, 'autocomplete') || ''} ${attribute(tag, 'placeholder') || ''}`;
      if (type === 'password') forms.passwordFields += 1;
      if (/cc-number|card.?number|cardnum|cvv|cvc|expir/i.test(field)) forms.cardFields += 1;
    } else {
      const url = absolute(attribute(tag, name === 'link' ? 'href' : 'src'), baseHref);
      const kind = url && classifyResource(name, tag, url);
      if (kind) resources.push({ kind, url });
    }
  }

  for (const key of ['og:image', 'twitter:image']) {
    const url = absolute(meta[key], baseHref);
    if (url) resources.push({ kind: 'image', url });
  }

  const seen = new Set();
  const cleanResources = [];
  for (const { kind, url } of resources) {
    const key = `${url.hostname}${url.pathname}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const host = cleanHost(url.hostname);
    cleanResources.push({
      kind,
      host,
      path: url.pathname,
      url: `${url.origin}${url.pathname}`,
      sameSite: registrableDomain(host) === pageDomain,
    });
    if (cleanResources.length >= 80) break;
  }

  const ogUrl = absolute(meta['og:url'], baseHref);
  const externalHosts = uniq([
    ...cleanResources.filter((item) => !item.sameSite).map((item) => item.host),
    ...forms.actionHosts.filter((host) => registrableDomain(host) !== pageDomain),
  ]);
  const text = visibleText(html);
  const title = titleMatch
    ? decodeEntities(titleMatch[1]).replace(/\s+/g, ' ').trim().slice(0, 300)
    : null;
  const contacts = [...collect(html, CONTACTS, 5), ...collect(text, TEXT_CONTACTS, 5)]
    .map(tidyContact)
    .filter(Boolean);
  const seenContacts = new Set();

  return {
    seo: seoFacts(html, meta, title, text, linkCounts),
    structure: structureHash(html),
    content: contentHash(text),
    title: titleMatch
      ? decodeEntities(titleMatch[1]).replace(/\s+/g, ' ').trim().slice(0, 300)
      : null,
    description: meta.description || meta['og:description'] || null,
    language: (html.match(/<html[^>]{0,300}\blang\s*=\s*["']?([a-zA-Z-]{2,10})/i) || [])[1] || null,
    generator: meta.generator || null,
    og: {
      title: meta['og:title'] || null,
      siteName: meta['og:site_name'] || null,
      url: ogUrl ? ogUrl.href : null,
      // A preview that claims to be whatsapp.com or a bank, on a page that is neither
      spoofedHost:
        ogUrl && registrableDomain(ogUrl.hostname) !== pageDomain
          ? cleanHost(ogUrl.hostname)
          : null,
    },
    resources: cleanResources,
    externalHosts,
    linkHosts: [...linkHosts].filter((host) => registrableDomain(host) !== pageDomain).slice(0, 40),
    forms: { ...forms, actionHosts: uniq(forms.actionHosts) },
    trackers: collect(html, TRACKERS),
    contacts: contacts
      .filter(
        (item) =>
          !seenContacts.has(`${item.kind}:${item.id}`) &&
          seenContacts.add(`${item.kind}:${item.id}`),
      )
      .slice(0, 20),
    behaviour: scriptBehaviour(html),
    redirectTargets: scriptRedirects(html, pageUrl),
    text: text.slice(0, 1500),
    textLength: text.length,
  };
};

// Fetch a URL and whatever its scripts hand off to, merging what each stage reveals
export const crawlPage = async (ctx, url, opts = {}) => {
  const stages = [];
  const visited = new Set();
  const documents = [];
  let next = url;
  let merged = null;

  while (next && stages.length < (opts.maxStages || MAX_STAGES) && !visited.has(next)) {
    visited.add(next);
    let page;
    try {
      page = await fetchPage(ctx, next, opts);
    } catch (error) {
      if (!stages.length) throw error;
      stages.push({ url: next, error: error.message });
      break;
    }
    const print = extractFingerprint(page.html, page.finalUrl);
    documents.push(page.html);
    stages.push({
      url: page.finalUrl,
      status: page.status,
      title: print.title,
      contentType: (page.headers['content-type'] || '').split(';')[0],
      length: page.bytes.length,
      redirects: page.chain,
    });
    if (!merged) {
      merged = {
        requestedUrl: url,
        finalUrl: page.finalUrl,
        status: page.status,
        server: page.headers.server || null,
        poweredBy: page.headers['x-powered-by'] || null,
        contentType: (page.headers['content-type'] || '').split(';')[0],
        bodySha256: sha256(page.bytes),
        bodyLength: page.bytes.length,
        ...print,
      };
    } else {
      merged.title = merged.title || print.title;
      merged.description = merged.description || print.description;
      merged.resources = mergeBy([...merged.resources, ...print.resources], (r) => r.url).slice(
        0,
        120,
      );
      merged.externalHosts = uniq([...merged.externalHosts, ...print.externalHosts]);
      merged.linkHosts = uniq([...merged.linkHosts, ...print.linkHosts]).slice(0, 60);
      merged.trackers = mergeBy(
        [...merged.trackers, ...print.trackers],
        (t) => `${t.kind}:${t.id}`,
      );
      merged.contacts = mergeBy(
        [...merged.contacts, ...print.contacts],
        (c) => `${c.kind}:${c.id}`,
      );
      merged.forms = {
        count: merged.forms.count + print.forms.count,
        passwordFields: merged.forms.passwordFields + print.forms.passwordFields,
        cardFields: merged.forms.cardFields + print.forms.cardFields,
        actionHosts: uniq([...merged.forms.actionHosts, ...print.forms.actionHosts]),
      };
      for (const [key, value] of Object.entries(print.behaviour)) {
        if (typeof value === 'boolean') merged.behaviour[key] = merged.behaviour[key] || value;
      }
      merged.text = `${merged.text} ${print.text}`.slice(0, 3000);
      merged.textLength += print.textLength;
    }
    next = print.redirectTargets.find((target) => !visited.has(target)) || null;
  }

  merged.stages = stages;
  // Raw markup for kit-signature matching only; it is dropped before results are returned
  merged.rawHtml = documents.join('\n').slice(0, 1200000);
  merged.redirectHosts = uniq(
    stages
      .flatMap((stage) => [
        stage.url,
        ...(stage.redirects || []).flatMap((hop) => [hop.url, hop.location]),
      ])
      .map((value) => cleanHost(new URL(value).hostname)),
  );
  return merged;
};

const mergeBy = (items, keyOf) => {
  const seen = new Set();
  return items.filter((item) => {
    const key = keyOf(item);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

// How a site answers at its front door: scam kits often serve a stub there and hide the rest
export const rootFingerprint = async (ctx, origin, opts = {}) => {
  const page = await fetchPage(ctx, `${origin}/`, { ...opts, maxBytes: 64 * 1024 });
  const body = page.html.trim();
  return {
    status: page.status,
    contentType: (page.headers['content-type'] || '').split(';')[0],
    length: page.bytes.length,
    // Short bodies are kept (they're often a kit's calling card), long ones only hashed
    sample: body.length <= 200 ? body : null,
    sha256: sha256(page.bytes),
    redirectedTo: page.finalUrl !== `${origin}/` ? page.finalUrl : null,
  };
};

const GENERIC_DIRS =
  /^(wp-content|wp-includes|wp-json|assets?|static|statics|public|dist|build|js|css|img|imgs|images?|fonts?|media|uploads?|themes?|plugins?|vendor|libs?|node_modules|cdn-cgi|_next|_nuxt|\.well-known|src|scripts?|styles?|files?|content|common|core|app|web|resources?)$/i;
const GENERIC_FILES =
  /^(index|main|app|bundle|vendor|runtime|polyfills?|chunk|styles?|common|global|theme|custom|scripts?|jquery|bootstrap|popper|swiper|slick|font-?awesome|all|logo|favicon|icon|banner|bg|background|header|footer|hero|image|img|photo|pic|default|\d{1,3})([.-][a-z0-9.-]+)?\.[a-z0-9]{2,5}$/i;

// How unusual a resource path is: generic names score 0 and are useless for linking sites
export const pathDistinctiveness = (pathname) => {
  const parts = String(pathname || '')
    .split('/')
    .filter(Boolean);
  if (!parts.length) return 0;
  const file = parts[parts.length - 1];
  const dirs = parts.slice(0, -1);
  // CMS and package paths are shared by millions of unrelated sites
  if (dirs.some((dir) => /^(wp-content|wp-includes|wp-admin|node_modules|vendor)$/i.test(dir)))
    return 0;
  let score = dirs.filter((dir) => dir.length >= 5 && !GENERIC_DIRS.test(dir)).length;
  // A build hash in the filename is unique to one bundle
  if (/[a-f0-9]{8,}/i.test(file) && !/^\d+\.[a-z0-9]+$/i.test(file)) score += 2;
  else if (file.includes('.') && file.length >= 8 && !GENERIC_FILES.test(file)) score += 1;
  return score;
};

// The resource paths most likely to be shared by copies of the same kit
export const distinctiveResources = (resources, limit = 4) =>
  (resources || [])
    .filter((item) => item.sameSite && !item.path.startsWith('/cdn-cgi/'))
    .map((item) => ({ ...item, score: pathDistinctiveness(item.path) }))
    .filter((item) => item.score >= 1)
    .sort((a, b) => b.score - a.score || b.path.length - a.path.length)
    .slice(0, limit);

// Download a few static files and hash them, so identical files elsewhere can be found
export const hashResources = async (ctx, resources, limit = 3) => {
  const picks = [
    ...(resources || []).filter((item) => item.sameSite && item.kind === 'image'),
    ...(resources || []).filter((item) => item.sameSite && item.kind !== 'image'),
  ].slice(0, limit);
  const hashes = [];
  for (const item of picks) {
    try {
      await assertPublicHost(ctx, item.host);
      const response = await ctx.fetch(item.url, {
        headers: { 'user-agent': MOBILE_UA },
        timeoutMs: 12000,
        maxBytes: 3 * 1024 * 1024,
      });
      const type = (response.headers['content-type'] || '').split(';')[0];
      // An HTML reply here is an error page or a cloak, not the file we asked for
      if (!response.ok || response.truncated || response.bytes.length < 512 || /html/i.test(type)) {
        continue;
      }
      hashes.push({
        url: item.url,
        path: item.path,
        kind: item.kind,
        sha256: sha256(response.bytes),
        size: response.bytes.length,
      });
    } catch (error) {
      if (error.code === 'BUDGET') break;
    }
  }
  return hashes;
};
