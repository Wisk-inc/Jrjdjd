// Offline judgement calls: what a domain name, a URL, or a page's wording says about intent
// Pure functions over data already collected, so they're cheap to run and easy to test

import { BRANDS, WELL_KNOWN_DOMAINS } from '../data/brands.js';
import { SIGNATURES } from '../data/signatures.js';
import {
  cleanHost,
  detectScript,
  flagCountries,
  hostingPlatform,
  normalizeTitle,
  registeredLabel,
  registrableDomain,
  shannonEntropy,
  stripEmoji,
  tldOf,
} from './util.js';

// TLDs that are cheap to burn through and heavily over-represented in abuse reports
// A risky TLD is never proof on its own: plenty of honest sites use them
export const RISKY_TLDS = new Set(
  (
    'buzz xyz top cfd sbs icu click cyou rest lol monster quest bond lat help vip work shop ' +
    'live online site store fun space website cam beauty hair skin makeup autos boats yachts ' +
    'mom pics ink wiki life world today support center digital win bid loan men stream gdn ' +
    'review party date download racing cricket science faith tk ml ga cf gq zip mov'
  ).split(' '),
);

const VOWELS = /[aeiou]/g;
// Letter pairs that make up most English and romanised words; random strings rarely hit them
export const COMMON_PAIRS = new Set(
  (
    'th he in er an re on at en nd ti es or te of ed is it al ar st to nt ng se ha as ou io le ' +
    've co me de hi ri ro ic ne ea ra ce li ch ll be ma si om ur ca el ta la ns di fo ho pe ec ' +
    'pr no ct us ac ot il tr ly nc et ut ss so rs un lo wa ge ie wh ee wi em ad ol rt po we na ' +
    'ul ni ts mo ow pa im mi ai sh ir su id os iv ia am fi ci vi pl ig tu ev ld ry mp fe bl ab ' +
    'gh ty op wo sa ay ex ke fr oo av ag if ap gr od bo sp rd do uc bu ei ov by rm ep tt oc fa ' +
    'ef cu rn sc gi da yo cr cl du ga qu ue ff ba ey ls va um pp ua up lu go ht ru ug ds lt pi ' +
    'rc rr eg au ck ew mu br bi pt ak pu ui rg ib tl ny ki rk ys ob mm fu ph og ms ye ud mb ip ' +
    'ub oi rl gu dr hr cc oa nn ja ka ko sk ya za ze zo'
  ).split(' '),
);

// What a registered name looks like once you ignore what it says
export const lexical = (hostname) => {
  const label = registeredLabel(hostname);
  const letters = label.replace(/[^a-z]/g, '');
  const pairs = [];
  for (let i = 0; i < letters.length - 1; i += 1) pairs.push(letters.slice(i, i + 2));
  const common = pairs.filter((pair) => COMMON_PAIRS.has(pair)).length;
  const vowels = (letters.match(VOWELS) || []).length;
  const longestConsonants = Math.max(0, ...letters.split(VOWELS).map((run) => run.length));
  const pairRatio = pairs.length ? common / pairs.length : 1;
  const vowelRatio = letters.length ? vowels / letters.length : 0;
  const digits = (label.match(/\d/g) || []).length;
  // Pronounceable names score well on at least one of these; machine-made ones fail several
  const randomLooking =
    letters.length >= 5 &&
    (pairRatio < 0.45 ||
      longestConsonants >= 4 ||
      (vowelRatio < 0.2 && letters.length >= 6) ||
      (digits >= 3 && letters.length >= 4 && digits / label.length > 0.3 && pairRatio < 0.7));
  return {
    label,
    length: label.length,
    digits,
    hyphens: (label.match(/-/g) || []).length,
    vowelRatio: Number(vowelRatio.toFixed(2)),
    pairRatio: Number(pairRatio.toFixed(2)),
    entropy: Number(shannonEntropy(label).toFixed(2)),
    randomLooking,
    punycode: cleanHost(hostname)
      .split('.')
      .some((part) => part.startsWith('xn--')),
  };
};

// A coarse "mould" for a domain name, so batches like five-letters-dot-buzz stand out
export const nameShape = (hostname) => {
  const label = registeredLabel(hostname);
  const domain = registrableDomain(hostname);
  const suffix = domain.slice(label.length + 1);
  let kind = 'mixed';
  if (/^[a-z]+$/.test(label)) kind = 'letters';
  else if (/^\d+$/.test(label)) kind = 'digits';
  else if (/^[a-z0-9]+$/.test(label)) kind = 'alnum';
  else if (/^[a-z0-9-]+$/.test(label)) kind = 'hyphenated';
  return `${kind}${label.length}.${suffix}`;
};

// Tell-tale structure in a link: tracking tokens, share-source tags, locale folders
export const urlShape = (value) => {
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  const segments = url.pathname.split('/').filter(Boolean);
  const query = url.search.slice(1);
  const params = query.split('&').filter(Boolean);
  const source = query.match(/(?:^|&)s=(wa|ms|fb|tg|ig|tw|sms|em)(?:&|$)/);
  const locale = segments.find((part) => /^[a-z]{2}-[a-z]{2}$/i.test(part));
  const host = cleanHost(url.hostname);
  const subdomain = host.slice(0, Math.max(0, host.length - registrableDomain(host).length - 1));
  return {
    longToken: segments.some((part) => part.length >= 40 && /^[A-Za-z0-9_-]+$/.test(part)),
    timestamp:
      segments.some((part) => /^1[5-9]\d{11}$/.test(part)) ||
      /(?:^|[&=#])1[5-9]\d{8,11}(?:&|$)/.test(`${query}${url.hash}`),
    bareNumericParam: params.some((part) => /^\d{15,20}$/.test(part)),
    shareSource: source ? source[1] : null,
    locale: locale ? locale.toLowerCase() : null,
    randomFirstSegment:
      segments.length > 0 &&
      /^[A-Za-z]{5,12}$/.test(segments[0]) &&
      /[A-Z]/.test(segments[0]) &&
      /[a-z]/.test(segments[0]),
    ipHost: /^\d{1,3}(\.\d{1,3}){3}$/.test(host),
    userInfo: Boolean(url.username),
    deepSubdomain: subdomain ? subdomain.split('.').length >= 3 : false,
    subdomain,
  };
};

// Wording that scams lean on, by type. `strong` cues are telling on their own; `weak` ones
// (plain words like "gift" or "lottery") only count in pairs, since honest sites use them too
const LURES = [
  {
    id: 'giveaway',
    label: 'Prize or giveaway bait',
    strong: [
      /\b(you('ve| have)? (won|been (selected|chosen))|lucky (draw|winner|visitor))\b/i,
      /\bfree (data|internet|airtime|recharge|credit|\d+ ?gb)\b|\b\d+ ?gb (free|of free|data)\b/i,
      /\b(anniversary|birthday|independence day|heroes.{0,2} day|emancipation day|christmas|easter|new year|eid|ramadan|diwali|black friday|mother.?s day|father.?s day|valentine.?s?( day)?|bonifacio day|national day|women.?s day)\b.{0,30}\b(gift|gifts|reward|subsidy|giveaway|prize|bonus)\b/i,
      /\b(everyone|everybody) (can )?(get|receive|claim)\b/i,
      /(free|ফ্রি|फ्री|मुफ्त|مجان[اي]|gratis|grátis|gratuit)\s?(internet|data|ইন্টারনেট|ডাটা|ডেটা|इंटरनेट|डेटा|إنترنت|انترنت)/iu,
      /\b(spin (the )?wheel|claim (your|my) (gift|prize|reward)|gift box(es)?)\b/i,
    ],
    weak: [
      /\b(gift|gifts|giveaway|prize|prizes|reward|rewards|voucher|coupon)s?\b/i,
      /\b(congratulations|don.?t miss out|limited (quantity|offer|time))\b/i,
      /\b(regalo|premio|sorteo|ganador|gratis|presente|brinde|prêmio|grátis|cadeau|gagnant|gratuit|hadiah|kuota|zawadi)\b/i,
      /উপহার|ফ্রি|තෑග්ග|उपहार|मुफ्त|هدية|مجانا|جائزة|ฟรี|ของขวัญ|免费|礼品/u,
      // The chain kits' title mould: emoji, a name, a dash, a promise, "!" and more emoji
      /^\P{L}*\p{L}.{1,40} - .{3,60}!\P{L}*$/u,
    ],
  },
  {
    id: 'government-benefit',
    label: 'Fake grant, subsidy or relief payment',
    strong: [
      /\b(government|govt|federal|national|presidential|ministry)\b.{0,40}\b(grant|subsid(y|ies)|relief|stimulus|benefit|allowance|fund|support)\b/i,
      /\b(relief (fund|package|payment)|stimulus (check|payment)|cash transfer|social (grant|relief)|empowerment (fund|grant)|tax refund)\b/i,
    ],
    weak: [/\b(subsidio|bono|auxílio|ayuda económica|bantuan|subsidy|grant)\b/i],
  },
  {
    id: 'lottery',
    label: 'Lottery, sweepstakes or advance-fee pitch',
    strong: [
      /\b(winning (notification|number|ticket)|unclaimed (funds|prize|winnings)|beneficiary|next of kin|inheritance)\b/i,
      /\b(processing|clearance|handling|courier|transfer) fee\b/i,
      /\b(compensation (fund|payment)|claims? (agent|officer|department)|atm card)\b/i,
    ],
    weak: [
      /\b(lottery|lotto|sweepstakes?|jackpot|mega millions|powerball|publishers clearing house)\b/i,
      /\b(winner|winners|winnings)\b/i,
    ],
  },
  {
    id: 'account-phishing',
    label: 'Account or banking sign-in bait',
    strong: [
      /\b(verify|confirm|validate|update|unlock|restore|secure) (your )?(account|identity|details|information|payment|billing|card|wallet)\b/i,
      /\baccount (has been |is |was )?(suspended|locked|limited|restricted|on hold|disabled)\b/i,
      /\b(unusual|suspicious|unauthori[sz]ed) (activity|sign.?in|login|transaction)\b/i,
    ],
    weak: [
      /\b(online|internet|mobile) banking\b/i,
      /\b(sign|log) ?in to (your )?(account|online)\b/i,
    ],
  },
  {
    id: 'delivery',
    label: 'Parcel or delivery fee bait',
    strong: [
      /\b(parcel|package|shipment|delivery) (is |was |has been )?(on hold|held|pending|failed|undelivered|waiting|suspended)\b/i,
      /\b(redelivery|reschedule (your )?delivery|customs (fee|duty|charge)|incomplete address)\b/i,
    ],
    weak: [/\b(shipping fee|delivery attempt|track(ing)? (your )?(parcel|package))\b/i],
  },
  {
    id: 'crypto',
    label: 'Crypto or investment bait',
    strong: [
      /\b(seed phrase|recovery phrase|private key)\b/i,
      /\b(double your|guaranteed (profit|returns?)|\d+% (daily|weekly|roi))\b/i,
    ],
    weak: [
      /\b(airdrop|presale|token (claim|sale)|connect (your )?wallet)\b/i,
      /\b(trading (bot|signals)|cloud mining|staking rewards)\b/i,
      /\b(invest(ment)? (plan|platform|package)|passive income|withdraw(al)? (profit|earnings))\b/i,
    ],
  },
  {
    id: 'tech-support',
    label: 'Fake security warning',
    strong: [
      /\b(virus|trojan|spyware|malware) (detected|found|alert|warning)\b/i,
      /\byour (computer|pc|device|iphone|phone) (is|has been|may be) (infected|locked|blocked|hacked|at risk)\b/i,
    ],
    weak: [
      /\b(windows defender|security (alert|warning)|call (support|microsoft|apple)|toll.?free)\b/i,
    ],
  },
  {
    id: 'investment',
    label: 'Fake investment or paid-task platform',
    strong: [
      /\b(?:daily|per day) (?:income|profit|earnings?|returns?|commission)\b/i,
      /\bgrab (?:an? )?orders?\b|\btask (?:hall|center|commission)\b|\bVIP ?[1-9]\b.{0,40}\b(?:recharge|commission|income)\b/i,
    ],
    weak: [
      /\b(?:recharge|top[- ]?up|deposit) (?:now|bonus|amount)\b/i,
      /\b(?:invite|referral|team) (?:bonus|commission|rebate)\b/i,
      /\bwithdraw(?:al)? (?:record|now|anytime)\b/i,
    ],
  },
  {
    id: 'loan',
    label: 'Advance-fee loan offer',
    strong: [
      /\b(?:instant|guaranteed|same[- ]day) (?:loan|approval)\b.{0,80}\b(?:no credit check|bad credit|without collateral)\b/i,
      /\bloan\b.{0,60}\b(?:processing|insurance|activation|registration) fee\b/i,
    ],
    weak: [
      /\b(?:instant|quick|easy|personal) loans?\b/i,
      /\bno credit check\b|\bbad credit (?:ok|welcome|accepted)\b/i,
    ],
  },
  {
    id: 'recovery',
    label: 'Fund-recovery pitch aimed at people already scammed',
    strong: [
      /\b(?:recover|retrieve|get back) (?:your )?(?:lost|stolen|scammed) (?:funds|money|crypto|bitcoin|investment)\b/i,
      /\b(?:fund|asset|crypto|chargeback) recovery (?:expert|agent|service|specialist|team)s?\b/i,
    ],
    weak: [/\b(?:scam|fraud) victims?\b/i, /\bmoney[- ]back\b|\bchargeback\b/i],
  },
  {
    id: 'job',
    label: 'Fake job or "task" earnings',
    strong: [
      /\bearn (up to )?[$€£₹₦]?\s?\d[\d,]* ?(k|usd|dollars|naira|rupees|pesos)? ?(daily|per day|a day|weekly|per hour)\b/i,
      /\b(task|like|review|rating)s? (commission|reward|earn)|complete tasks? (and|to) earn\b/i,
    ],
    weak: [/\b(work from home|part.?time job|online job|data entry job)\b/i],
  },
];

const cuesIn = (value, patterns) =>
  patterns
    .map((pattern) => value.match(pattern))
    .filter(Boolean)
    .map((match) => match[0].trim().slice(0, 40));

// Which kinds of bait some text uses, with a strength that grows with distinct cues
export const findLures = (text) => {
  const value = String(text || '');
  if (!value) return [];
  const found = [];
  for (const lure of LURES) {
    const strong = cuesIn(value, lure.strong);
    const weak = cuesIn(value, lure.weak);
    if (!strong.length && weak.length < 2) continue;
    found.push({
      id: lure.id,
      label: lure.label,
      cues: [...strong, ...weak].slice(0, 5),
      strength: Math.min(1, 0.4 + 0.25 * strong.length + 0.1 * weak.length),
    });
  }
  return found.sort((a, b) => b.strength - a.strength);
};

const escapeRegex = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const brandWordPatterns = new Map();

const wordPattern = (word) => {
  if (!brandWordPatterns.has(word)) {
    // Unicode-aware boundaries, so "ups" doesn't fire inside "groups"
    brandWordPatterns.set(
      word,
      new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegex(word)}(?![\\p{L}\\p{N}])`, 'iu'),
    );
  }
  return brandWordPatterns.get(word);
};

// Long tokens may sit anywhere in a hostname; short ones (and "kfc-" style prefixes) must be
// a whole dash- or dot-separated part, or "ups" would match every "groups" and "startups"
const tokenInHost = (token, full, parts) => {
  const word = token.replace(/-$/, '');
  return word.length >= 5 && word === token ? full.includes(word) : parts.includes(word);
};

// True when a hostname really belongs to the brand
export const isOfficialDomain = (brand, hostname) => {
  const host = cleanHost(hostname);
  return brand.domains.some((domain) => host === domain || host.endsWith(`.${domain}`));
};

// Brands named in a page or wedged into its domain, and whether the site is the real one
export const findBrands = ({ title, text, host }) => {
  const full = host ? cleanHost(host) : '';
  const parts = full.split(/[.-]/);
  const hits = [];
  for (const brand of BRANDS) {
    const official = host ? isOfficialDomain(brand, host) : false;
    const inDomain = !official && brand.tokens.some((token) => tokenInHost(token, full, parts));
    const inTitle = brand.words.some((word) => wordPattern(word).test(title || ''));
    const inText = !inTitle && brand.words.some((word) => wordPattern(word).test(text || ''));
    if (official || inDomain || inTitle || inText) {
      hits.push({
        id: brand.id,
        name: brand.name,
        country: brand.country,
        sector: brand.sector,
        common: Boolean(brand.common),
        official,
        inDomain,
        inTitle,
        inText,
      });
    }
  }
  return hits;
};

const wellKnown = new Set(WELL_KNOWN_DOMAINS);

// Big platforms and CDNs: never candidates for "related scam site", whatever links to them
export const isWellKnown = (hostname) => {
  // Google Translate serves other sites under its own name; the page is not Google's, but
  // it is not a site of its own either
  if (cleanHost(hostname).endsWith('.translate.goog')) return true;
  const domain = registrableDomain(hostname);
  if (wellKnown.has(domain)) return true;
  // A platform's own front page, as opposed to one tenant's subdomain
  if (hostingPlatform(`x.${domain}`) === domain) return true;
  return BRANDS.some((brand) => isOfficialDomain(brand, hostname));
};

// Currency codes and symbols that name a country when they appear beside an amount
// prettier-ignore
const CURRENCIES = {
  EGP: 'EG', AED: 'AE', SAR: 'SA', QAR: 'QA', KWD: 'KW', OMR: 'OM', BHD: 'BH', JOD: 'JO',
  IQD: 'IQ', MAD: 'MA', DZD: 'DZ', TND: 'TN', KES: 'KE', NGN: 'NG', GHS: 'GH', ZAR: 'ZA',
  TZS: 'TZ', UGX: 'UG', RWF: 'RW', ETB: 'ET', ZMW: 'ZM', PKR: 'PK', INR: 'IN', BDT: 'BD',
  LKR: 'LK', NPR: 'NP', PHP: 'PH', THB: 'TH', MYR: 'MY', IDR: 'ID', VND: 'VN', MMK: 'MM',
  KHR: 'KH', JMD: 'JM', TTD: 'TT', BBD: 'BB', BSD: 'BS', GYD: 'GY', XCD: null, USD: 'US',
  CAD: 'CA', GBP: 'GB', AUD: 'AU', NZD: 'NZ', BRL: 'BR', MXN: 'MX', COP: 'CO', ARS: 'AR',
  PEN: 'PE', CLP: 'CL', TRY: 'TR', UAH: 'UA', KZT: 'KZ',
};
const CURRENCY_SYMBOLS = [
  [/₹\s?\p{Nd}/u, 'IN'],
  [/₦\s?\p{Nd}/u, 'NG'],
  [/₱\s?\p{Nd}/u, 'PH'],
  [/৳\s?\p{Nd}/u, 'BD'],
  [/฿\s?\p{Nd}/u, 'TH'],
  [/₫|\d\s?đ\b/, 'VN'],
  [/₺\s?\d/, 'TR'],
  [/₴\s?\d/, 'UA'],
  [/\bJ\$\s?\d/, 'JM'],
  [/\bR\$\s?\d/, 'BR'],
  [/\bKSh\.?\s?\d/i, 'KE'],
  [/\bRM\s?\d/, 'MY'],
  [/\bRp\.?\s?\d/, 'ID'],
  [/\bGH[₵S]\s?\d/, 'GH'],
  [/(?<![\p{L}$])R\s?\d{1,3}([,\s]\d{3})+/u, 'ZA'],
];

// Countries named by a currency next to a number, like "EGP 3,000" or "₹8,000"
export const currencyCountries = (text) => {
  const value = String(text || '');
  const found = [];
  for (const match of value.matchAll(/\b([A-Z]{3})\s?\d|\d\s?([A-Z]{3})\b/g)) {
    const country = CURRENCIES[match[1] || match[2]];
    if (country) found.push(country);
  }
  for (const [pattern, country] of CURRENCY_SYMBOLS) if (pattern.test(value)) found.push(country);
  return [...new Set(found)];
};

// Country names that are also ordinary words or names, so can't be trusted in a title
const AMBIGUOUS_COUNTRIES = new Set([
  'GE',
  'JE',
  'TD',
  'TR',
  'NE',
  'ML',
  'GG',
  'IM',
  'GN',
  'TG',
  'DM',
  'RE',
]);

// What the people of the most-targeted countries are called, as whole English words
// prettier-ignore
const PEOPLES = {
  JM: 'jamaicans?', NG: 'nigerians?', KE: 'kenyans?', GH: 'ghanaians?', ZA: 'south africans?',
  UG: 'ugandans?', TZ: 'tanzanians?', ET: 'ethiopians?', EG: 'egyptians?', IN: 'indians?',
  PK: 'pakistanis?', BD: 'bangladeshis?', LK: 'sri lankans?', NP: 'nepal(i|ese)',
  PH: 'filipinos?|pinoy', ID: 'indonesians?', MY: 'malaysians?', TH: 'thais?', VN: 'vietnamese',
  SA: 'saudis?', AE: 'emiratis?', BR: 'brazilians?|brasileiros?', MX: 'mexican(s|os)?',
  CO: 'colombian(s|os)?', CA: 'canadians?', GB: 'british|britons?', AU: 'australians?',
  TT: 'trinidadians?', BB: 'barbadians?|bajans?', GY: 'guyanese', DZ: 'algerians?', MA: 'moroccans?',
};

// The same countries in their own scripts. Matched anywhere, since these languages inflect
// prettier-ignore
const NATIVE_NAMES = {
  IN: 'भारत|ভারত|இந்திய|ഇന്ത്യ|భారత|ಭಾರತ|ଭାରତ|ભારત|ਭਾਰਤ', PK: 'پاکستان', BD: 'বাংলাদেশ',
  LK: 'ශ්‍රී ලංකා|இலங்கை', NP: 'नेपाल', TH: 'ประเทศไทย', ET: 'ኢትዮጵያ', EG: 'مصر',
  SA: 'السعودية', AE: 'الإمارات', DZ: 'الجزائر', MA: 'المغرب', VN: 'việt nam',
};

let countryPatterns = null;

// A whole-word pattern per country, built once from the runtime's own list of country names
const loadCountryPatterns = () => {
  if (countryPatterns) return countryPatterns;
  countryPatterns = [];
  const names = new Intl.DisplayNames(['en'], { type: 'region' });
  for (let first = 65; first <= 90; first += 1) {
    for (let second = 65; second <= 90; second += 1) {
      const code = String.fromCharCode(first, second);
      let name;
      try {
        name = names.of(code);
      } catch {
        continue;
      }
      if (!name || name === code || AMBIGUOUS_COUNTRIES.has(code) || name.length < 4) continue;
      const words = [name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').toLowerCase(), PEOPLES[code]]
        .filter(Boolean)
        .join('|');
      const native = NATIVE_NAMES[code] ? `|${NATIVE_NAMES[code]}` : '';
      countryPatterns.push([
        code,
        new RegExp(`(?<![\\p{L}\\p{N}])(${words})(?![\\p{L}\\p{N}])${native}`, 'iu'),
      ]);
    }
  }
  return countryPatterns;
};

// Countries a title names outright, in English or (for the most targeted) their own script
export const namedCountries = (text) => {
  const value = String(text || '');
  if (!value) return [];
  return loadCountryPatterns()
    .filter(([, pattern]) => pattern.test(value))
    .map(([code]) => code);
};

// Who a page is aimed at. Evidence is taken in order of reliability, stopping at the first
// kind that says anything: a flag in the title, a national currency, a country or people
// named in it, the home country of the brand being impersonated, then an unambiguous script.
// The locale folder some kits put in their links is ignored on purpose: it follows the
// visitor, not the campaign
export const targetCountries = ({ title, brands = [], lures = [] }) => {
  const script = detectScript(stripEmoji(title));
  const tiers = [
    flagCountries(title).map((country) => ({ country, why: 'flag in the title' })),
    currencyCountries(title).map((country) => ({ country, why: 'currency in the title' })),
    namedCountries(title).map((country) => ({ country, why: 'named in the title' })),
    brands
      // A name that is also an everyday word or a bare acronym ("Globe", "JPS") only counts
      // next to scam bait, or when it is in the domain itself
      .filter((brand) => brand.country && !brand.official)
      .filter((brand) => brand.inDomain || (brand.inTitle && (!brand.common || lures.length > 0)))
      .map((brand) => ({ country: brand.country, why: `impersonates ${brand.name}` })),
    script?.country ? [{ country: script.country, why: `${script.script} script` }] : [],
  ];
  const found = tiers.find((tier) => tier.length) || [];
  const seen = new Set();
  return found.filter((hit) => !seen.has(hit.country) && seen.add(hit.country));
};

const ruleSubject = (rule, profile, html) => {
  const page = profile.page || {};
  switch (rule.on) {
    case 'html':
      return [html || ''];
    case 'title':
      return [page.title || ''];
    case 'text':
      return [`${page.title || ''} ${page.description || ''} ${page.text || ''}`];
    case 'url':
      return [page.requestedUrl || '', page.finalUrl || '', ...(profile.urls || [])];
    case 'root':
      return [profile.root?.sample || ''];
    case 'paths':
      return (page.resources || []).map((resource) => resource.path);
    case 'hidden':
      return page.behaviour?.hiddenStrings || [];
    case 'ogSpoof':
      return [page.og?.spoofedHost || ''];
    default:
      return [];
  }
};

// Which known kits a profile matches, with the rules that fired as evidence
export const matchSignatures = (profile, html = '') => {
  const matches = [];
  for (const signature of SIGNATURES) {
    let score = 0;
    const fired = [];
    for (const rule of signature.rules) {
      let hit = false;
      if (rule.on === 'behaviour') hit = Boolean(profile.page?.behaviour?.[rule.match]);
      else if (rule.on === 'forms') hit = (profile.page?.forms?.[rule.match] || 0) > 0;
      else
        hit = ruleSubject(rule, profile, html).some(
          (subject) => subject && rule.match.test(subject),
        );
      if (hit) {
        score += rule.weight || 1;
        fired.push(rule.note || `${rule.on}: ${rule.match}`);
      }
    }
    if (score >= signature.threshold) {
      matches.push({
        id: signature.id,
        name: signature.name,
        category: signature.category,
        description: signature.description,
        score,
        evidence: fired,
        pivots: signature.pivots,
        lureOnAnyPath: Boolean(signature.lureOnAnyPath),
      });
    }
  }
  return matches;
};

const GENERIC_TITLES = new Set(
  [
    'home',
    'homepage',
    'index',
    'login',
    'log in',
    'sign in',
    'signin',
    'welcome',
    'untitled',
    'document',
    'error',
    'not found',
    'page not found',
    'access denied',
    'forbidden',
    'just a moment',
    'attention required cloudflare',
    'loading',
    'redirecting',
    'verification',
    'verification page',
    'coming soon',
    'site not found',
    'new tab',
    'webmail login',
    'default web site page',
    'welcome to nginx',
    'suspected phishing site cloudflare',
    'dns resolution error',
    'privacy error',
    'under construction',
    'account suspended',
  ].map(normalizeTitle),
);

// Titles specific enough that two sites sharing one is unlikely to be a coincidence
export const usableTitle = (title) => {
  const key = normalizeTitle(title);
  // A bare image opened in a browser is titled like "01.jpg (800×450)"
  if (/\.(jpe?g|png|gif|webp|svg|ico)\s*\(\d+\s*[×x]\s*\d+\)\s*$/i.test(String(title || '')))
    return false;
  return key.length >= 10 && !GENERIC_TITLES.has(key) && !/^(index of|error|[1-5]\d\d\b)/.test(key);
};

export const tldRisk = (hostname) => RISKY_TLDS.has(tldOf(hostname));
