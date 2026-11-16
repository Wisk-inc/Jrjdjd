// Small shared helpers: hashing, domain parsing, defanging, text normalisation
// Everything here is dependency-free, so the CLI and MCP server run on a bare Node install

import crypto from 'node:crypto';
import net from 'node:net';

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex');
export const sha1 = (data) => crypto.createHash('sha1').update(data).digest('hex');
export const uniq = (items) => [...new Set(items)];
export const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
export const isIp = (host) => net.isIP(host) !== 0;

// Two-label public suffixes worth knowing without the full Public Suffix List
const COUNTRY_SECOND_LEVELS =
  'ac co com edu gov govt gob gouv go gv mil ne net nom or org sch web id in info biz ltd plc me';

// Country TLDs that register under the second-level labels above (like example.com.jm)
const COUNTRY_TLDS =
  'ae ag ai al ar at au bb bd bh bn bo br bs bw by bz ch cn co cr cu cy do dz ec eg es et fj ' +
  'gd gh gi gr gt gy hk hn hr hu id il in iq ir it jm jo jp ke kh kr kw ky kz lb lc lk ly ma ' +
  'mm mo mt mu mx my mz na ng ni no np nz om pa pe pg ph pk pl pr pt py qa ro rs ru rw sa sb ' +
  'sc sd se sg sl sv sy th tn tr tt tw tz ua ug uk uy uz vc ve vn ye za zm zw';

// Hosting platforms where every subdomain belongs to a different customer
const PRIVATE_SUFFIXES = [
  '000webhostapp.com',
  '42web.io',
  'appspot.com',
  'azurewebsites.net',
  'backblazeb2.com',
  'blob.core.windows.net',
  'blogspot.com',
  'bubbleapps.io',
  'canva.site',
  'carrd.co',
  'cloudfront.net',
  'codeanyapp.com',
  'cprapid.com',
  'ddns.net',
  'deno.dev',
  'duckdns.org',
  'edgeone.app',
  'epizy.com',
  'firebaseapp.com',
  'fly.dev',
  'framer.app',
  'framer.website',
  'free.nf',
  'gitbook.io',
  'github.io',
  'gitlab.io',
  'glitch.me',
  'godaddysites.com',
  'great-site.net',
  'herokuapp.com',
  'hopto.org',
  'infinityfreeapp.com',
  'jimdofree.com',
  'jimdosite.com',
  'kesug.com',
  'lovable.app',
  'mailchimpsites.com',
  'myshopify.com',
  'mystrikingly.com',
  'netlify.app',
  'ngrok-free.app',
  'ngrok.io',
  'notion.site',
  'onrender.com',
  'pages.dev',
  'pantheonsite.io',
  'plesk.page',
  'r2.dev',
  'repl.co',
  'replit.app',
  'replit.dev',
  'rf.gd',
  'softr.app',
  'square.site',
  'surge.sh',
  'sytes.net',
  'tiiny.site',
  'trycloudflare.com',
  'typedream.app',
  'vercel.app',
  'web.app',
  'web.core.windows.net',
  'webflow.io',
  'weebly.com',
  'wixsite.com',
  'wixstudio.com',
  'wordpress.com',
  'workers.dev',
  'wuaze.com',
  'yolasite.com',
  'zapto.org',
];

const secondLevels = new Set(COUNTRY_SECOND_LEVELS.split(' '));
const countryTlds = new Set(COUNTRY_TLDS.split(' '));
const privateSuffixes = new Set(PRIVATE_SUFFIXES);

// Filled by loadPsl() when the optional `psl` package is installed
let pslParse = null;

// Use the real Public Suffix List when it's around, the built-in tables otherwise
export const loadPsl = async () => {
  if (pslParse !== null) return pslParse !== false;
  try {
    const mod = await import('psl');
    const parse = mod.parse || mod.default?.parse;
    pslParse = typeof parse === 'function' ? parse : false;
  } catch {
    pslParse = false;
  }
  return pslParse !== false;
};

// How many labels the public suffix of a hostname takes up
const suffixLength = (labels) => {
  const count = labels.length;
  for (let take = Math.min(4, count - 1); take >= 2; take -= 1) {
    if (privateSuffixes.has(labels.slice(count - take).join('.'))) return take;
  }
  if (count >= 3 && countryTlds.has(labels[count - 1]) && secondLevels.has(labels[count - 2])) {
    return 2;
  }
  return 1;
};

// Tidy a hostname: lowercase, no trailing dot, no brackets around IPv6
export const cleanHost = (host) =>
  String(host || '')
    .trim()
    .toLowerCase()
    .replace(/^\[|]$/g, '')
    .replace(/\.$/, '');

// True when a hostname is the tenant of a shared hosting platform (like name.vercel.app)
export const hostingPlatform = (host) => {
  const labels = cleanHost(host).split('.');
  for (let take = Math.min(4, labels.length - 1); take >= 2; take -= 1) {
    const suffix = labels.slice(labels.length - take).join('.');
    if (privateSuffixes.has(suffix)) return suffix;
  }
  return null;
};

// Reduce a hostname to the domain someone actually registered (or their platform subdomain)
export const registrableDomain = (hostname) => {
  const host = cleanHost(hostname);
  if (!host || isIp(host) || !host.includes('.')) return host;
  const labels = host.split('.');
  // Platform tenants first, since the Public Suffix List skips some of these hosts
  if (hostingPlatform(host)) return labels.slice(-(suffixLength(labels) + 1)).join('.');
  if (pslParse) {
    const parsed = pslParse(host);
    if (parsed?.domain) return parsed.domain;
  }
  return labels.slice(-(suffixLength(labels) + 1)).join('.');
};

// The last label of a hostname
export const tldOf = (host) => cleanHost(host).split('.').pop() || '';

// The label a registrant chose, so "mlqla" for mlqla.buzz or sub.mlqla.buzz
export const registeredLabel = (host) => registrableDomain(host).split('.')[0] || '';

// Parse whatever the user gave us (URL, bare domain or defanged indicator) into parts
export const parseTarget = (input) => {
  const raw = refang(String(input || '').trim());
  if (!raw) throw new Error('No target provided');
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
  let url;
  try {
    url = new URL(withScheme);
  } catch {
    throw new Error(`Could not parse "${input}" as a URL or domain`);
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error(`Only http and https targets are supported, got ${url.protocol}`);
  }
  const host = cleanHost(url.hostname);
  if (!host || (!isIp(host) && !host.includes('.'))) {
    throw new Error(`"${input}" has no usable hostname`);
  }
  const hasPath = url.pathname !== '/' || url.search !== '';
  return {
    input: raw,
    url: url.href,
    host,
    domain: registrableDomain(host),
    path: url.pathname,
    search: url.search,
    hasPath,
    isIp: isIp(host),
  };
};

// Make an indicator safe to paste anywhere: hxxps://example[.]com/path
export const defang = (value) => {
  const text = String(value ?? '');
  const match = text.match(/^(https?):\/\/([^/?#]+)(.*)$/i);
  if (match) {
    const scheme = match[1].toLowerCase().replace('http', 'hxxp');
    return `${scheme}://${match[2].replace(/\./g, '[.]')}${match[3]}`;
  }
  return text.replace(/\./g, '[.]');
};

// Undo defanging, so indicators copied out of a report can be fed straight back in
export const refang = (value) =>
  String(value ?? '')
    .replace(/^hxxp/i, 'http')
    .replace(/\[\.\]|\(\.\)|\[dot\]|\(dot\)/gi, '.')
    .replace(/\[:\]/g, ':')
    .replace(/\[\/\]/g, '/');

// Private, loopback, link-local and other addresses a public scanner must never fetch
export const isPrivateIp = (ip) => {
  const host = cleanHost(ip);
  if (net.isIPv4(host)) {
    const [a, b] = host.split('.').map(Number);
    if (a === 0 || a === 10 || a === 127 || a >= 224) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    return a === 198 && (b === 18 || b === 19);
  }
  if (net.isIPv6(host)) {
    const mapped = host.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
    if (mapped) return isPrivateIp(mapped[1]);
    return host === '::' || host === '::1' || /^f[cdef]/i.test(host);
  }
  return false;
};

// Hostnames that only ever mean "this machine" or "this network"
export const isLocalName = (host) => {
  const name = cleanHost(host);
  return (
    name === 'localhost' ||
    name.endsWith('.localhost') ||
    name.endsWith('.local') ||
    name.endsWith('.internal') ||
    name.endsWith('.lan') ||
    name.endsWith('.home.arpa')
  );
};

// Bits of entropy per character, a rough "how random does this look" measure
export const shannonEntropy = (text) => {
  const value = String(text || '');
  if (!value) return 0;
  const counts = {};
  for (const char of value) counts[char] = (counts[char] || 0) + 1;
  return Object.values(counts).reduce((sum, count) => {
    const p = count / value.length;
    return sum - p * Math.log2(p);
  }, 0);
};

// Emoji, flags and other pictographs, which scam titles are stuffed with
const EMOJI = /[\p{Extended_Pictographic}\p{Regional_Indicator}\u200d\ufe0f\u20e3]/gu;

export const stripEmoji = (text) =>
  String(text || '')
    .replace(EMOJI, ' ')
    .replace(/\s+/g, ' ')
    .trim();

// A stable key for "the same title", ignoring emoji, case, punctuation and spacing
export const normalizeTitle = (title) =>
  stripEmoji(String(title || '').normalize('NFKC'))
    .toLowerCase()
    .replace(/[‘’“”'"`!?.,:;|()[\]{}<>*#~_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

// ISO country codes for any flag emoji in a string, like "JM" for the Jamaican flag
export const flagCountries = (text) => {
  const codes = [];
  const flags = String(text || '').match(/[\u{1F1E6}-\u{1F1FF}]{2}/gu) || [];
  for (const flag of flags) {
    const [first, second] = [...flag];
    codes.push(
      String.fromCharCode(first.codePointAt(0) - 0x1f1e6 + 65) +
        String.fromCharCode(second.codePointAt(0) - 0x1f1e6 + 65),
    );
  }
  return uniq(codes);
};

// Writing systems, with a country only where the script is used in essentially one place
// (Bengali, Tamil, Arabic, Cyrillic and Han span several countries, so they imply none)
const SCRIPTS = [
  ['Sinhala', /\p{Script=Sinhala}/u, 'LK'],
  ['Bengali', /\p{Script=Bengali}/u, null],
  ['Tamil', /\p{Script=Tamil}/u, null],
  ['Devanagari', /\p{Script=Devanagari}/u, 'IN'],
  ['Gujarati', /\p{Script=Gujarati}/u, 'IN'],
  ['Telugu', /\p{Script=Telugu}/u, 'IN'],
  ['Kannada', /\p{Script=Kannada}/u, 'IN'],
  ['Malayalam', /\p{Script=Malayalam}/u, 'IN'],
  ['Oriya', /\p{Script=Oriya}/u, 'IN'],
  ['Gurmukhi', /\p{Script=Gurmukhi}/u, 'IN'],
  ['Thai', /\p{Script=Thai}/u, 'TH'],
  ['Khmer', /\p{Script=Khmer}/u, 'KH'],
  ['Myanmar', /\p{Script=Myanmar}/u, 'MM'],
  ['Lao', /\p{Script=Lao}/u, 'LA'],
  ['Arabic', /\p{Script=Arabic}/u, null],
  ['Hebrew', /\p{Script=Hebrew}/u, 'IL'],
  ['Cyrillic', /\p{Script=Cyrillic}/u, null],
  ['Greek', /\p{Script=Greek}/u, 'GR'],
  ['Hangul', /\p{Script=Hangul}/u, 'KR'],
  ['Japanese', /[\p{Script=Hiragana}\p{Script=Katakana}]/u, 'JP'],
  ['Han', /\p{Script=Han}/u, null],
  ['Ethiopic', /\p{Script=Ethiopic}/u, 'ET'],
  ['Georgian', /\p{Script=Georgian}/u, 'GE'],
  ['Armenian', /\p{Script=Armenian}/u, 'AM'],
];

// The first non-Latin script found in some text, with the country it usually implies
export const detectScript = (text) => {
  const value = String(text || '');
  for (const [name, pattern, country] of SCRIPTS) {
    if (pattern.test(value)) return { script: name, country };
  }
  return null;
};

// Whole days between two dates, null when either is missing or invalid
export const daysBetween = (from, to = new Date()) => {
  const start = new Date(from).getTime();
  const end = new Date(to).getTime();
  if (Number.isNaN(start) || Number.isNaN(end)) return null;
  return Math.floor((end - start) / 86400000);
};

// Run async work over a list with a cap on how many run at once
export const mapLimit = async (items, limit, worker) => {
  const results = new Array(items.length);
  let next = 0;
  const run = async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await worker(items[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) || 1 }, run));
  return results;
};

// A wall-clock allowance, so long investigations stop cleanly instead of timing out
export class Budget {
  constructor(ms) {
    this.limit = ms > 0 ? ms : Infinity;
    this.started = Date.now();
  }

  elapsed() {
    return Date.now() - this.started;
  }

  left() {
    return this.limit - this.elapsed();
  }

  expired(reserveMs = 0) {
    return this.left() <= reserveMs;
  }
}

// Shorten long text for display, keeping the start
export const truncate = (text, max = 120) => {
  const value = String(text ?? '');
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
};
