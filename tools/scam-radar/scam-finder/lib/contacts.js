// Contact intelligence: what an email address or phone number says about itself, and
// whether it is already known to abuse-report services
//
// Scope, on purpose: this describes the *contact point a scam asks victims to use*. It
// reads the address or number itself (provider, country, numbering range), checks
// spam-report and breach-notification services that exist for exactly this, and never
// retrieves leaked passwords or personal records. An address on a scam page is often a
// hijacked or spoofed account, so nothing here identifies the person behind a scam

import { TTL } from './net.js';

const FREE_MAIL = new Set(
  (
    'gmail.com googlemail.com outlook.com hotmail.com live.com msn.com icloud.com me.com aol.com proton.me ' +
    'protonmail.com gmx.com gmx.net gmx.de mail.com yandex.com yandex.ru mail.ru zoho.com qq.com 163.com ' +
    '126.com tutanota.com tuta.io hey.com fastmail.com rediffmail.com web.de naver.com ymail.com rocketmail.com'
  ).split(' '),
);

const THROWAWAY_MAIL = new Set(
  (
    'mailinator.com guerrillamail.com 10minutemail.com tempmail.com temp-mail.org yopmail.com trashmail.com ' +
    'sharklasers.com getnada.com dispostable.com maildrop.cc throwawaymail.com mohmal.com emailondeck.com ' +
    'moakt.com mintemail.com fakeinbox.com mailnesia.com mytemp.email tempail.com'
  ).split(' '),
);

// Country calling codes, longest match wins
// prettier-ignore
const CALLING_CODES = {
  20: 'EG', 27: 'ZA', 30: 'GR', 31: 'NL', 32: 'BE', 33: 'FR', 34: 'ES', 36: 'HU', 39: 'IT', 40: 'RO',
  41: 'CH', 43: 'AT', 44: 'GB', 45: 'DK', 46: 'SE', 47: 'NO', 48: 'PL', 49: 'DE', 51: 'PE', 52: 'MX',
  53: 'CU', 54: 'AR', 55: 'BR', 56: 'CL', 57: 'CO', 58: 'VE', 60: 'MY', 61: 'AU', 62: 'ID', 63: 'PH',
  64: 'NZ', 65: 'SG', 66: 'TH', 81: 'JP', 82: 'KR', 84: 'VN', 86: 'CN', 90: 'TR', 91: 'IN', 92: 'PK',
  93: 'AF', 94: 'LK', 95: 'MM', 98: 'IR', 212: 'MA', 213: 'DZ', 216: 'TN', 218: 'LY', 220: 'GM',
  221: 'SN', 223: 'ML', 224: 'GN', 225: 'CI', 226: 'BF', 227: 'NE', 228: 'TG', 229: 'BJ', 231: 'LR',
  232: 'SL', 233: 'GH', 234: 'NG', 237: 'CM', 241: 'GA', 242: 'CG', 243: 'CD', 244: 'AO', 249: 'SD',
  250: 'RW', 251: 'ET', 252: 'SO', 254: 'KE', 255: 'TZ', 256: 'UG', 257: 'BI', 258: 'MZ', 260: 'ZM',
  261: 'MG', 263: 'ZW', 264: 'NA', 265: 'MW', 266: 'LS', 267: 'BW', 268: 'SZ', 351: 'PT', 352: 'LU',
  353: 'IE', 354: 'IS', 355: 'AL', 356: 'MT', 357: 'CY', 358: 'FI', 359: 'BG', 370: 'LT', 371: 'LV',
  372: 'EE', 373: 'MD', 374: 'AM', 375: 'BY', 380: 'UA', 381: 'RS', 385: 'HR', 386: 'SI', 420: 'CZ',
  421: 'SK', 501: 'BZ', 502: 'GT', 503: 'SV', 504: 'HN', 505: 'NI', 506: 'CR', 507: 'PA', 509: 'HT',
  591: 'BO', 592: 'GY', 593: 'EC', 595: 'PY', 597: 'SR', 598: 'UY', 673: 'BN', 675: 'PG', 679: 'FJ',
  852: 'HK', 853: 'MO', 855: 'KH', 856: 'LA', 880: 'BD', 886: 'TW', 960: 'MV', 961: 'LB', 962: 'JO',
  963: 'SY', 964: 'IQ', 965: 'KW', 966: 'SA', 967: 'YE', 968: 'OM', 971: 'AE', 972: 'IL', 973: 'BH',
  974: 'QA', 975: 'BT', 976: 'MN', 977: 'NP', 992: 'TJ', 993: 'TM', 994: 'AZ', 995: 'GE', 996: 'KG',
  998: 'UZ', 7: 'RU',
};

// +1 is shared by the US, Canada and much of the Caribbean; the area code says which
// prettier-ignore
const NANP_AREAS = {
  876: 'JM', 658: 'JM', 809: 'DO', 829: 'DO', 849: 'DO', 868: 'TT', 246: 'BB', 242: 'BS', 441: 'BM',
  345: 'KY', 268: 'AG', 284: 'VG', 340: 'VI', 473: 'GD', 649: 'TC', 664: 'MS', 758: 'LC', 767: 'DM',
  784: 'VC', 787: 'PR', 939: 'PR', 869: 'KN', 721: 'SX', 264: 'AI', 671: 'GU', 670: 'MP', 684: 'AS',
};
const CANADA_AREAS = new Set(
  (
    '204 226 236 249 250 263 289 306 343 354 365 367 368 382 403 416 418 428 431 437 438 450 468 474 506 ' +
    '514 519 548 579 581 584 587 604 613 639 647 672 683 705 709 742 753 778 780 782 807 819 825 867 873 879 902 905'
  ).split(' '),
);

// Area codes that regulators have warned about for "one ring" callback and lottery calls:
// they dial like US numbers but are international and can be billed at premium rates
const CALLBACK_WARNING = new Set([
  '268',
  '284',
  '473',
  '649',
  '664',
  '767',
  '809',
  '829',
  '849',
  '876',
  '658',
]);

const regionNames = new Intl.DisplayNames(['en'], { type: 'region' });
const countryName = (code) => {
  try {
    return regionNames.of(code) || code;
  } catch {
    return code;
  }
};

// Reduce a phone number to +digits, or null when it can't be one
export const normalizePhone = (value) => {
  const digits = String(value || '').replace(/\D/g, '');
  return digits.length >= 8 && digits.length <= 15 ? `+${digits}` : null;
};

// What a phone number says about itself: country, and any warning attached to its range
export const phoneInfo = (value) => {
  const phone = normalizePhone(value);
  if (!phone) return null;
  const digits = phone.slice(1);
  let country = null;
  const notes = [];
  if (digits[0] === '1' && digits.length === 11) {
    const area = digits.slice(1, 4);
    country = NANP_AREAS[area] || (CANADA_AREAS.has(area) ? 'CA' : 'US');
    if (CALLBACK_WARNING.has(area)) {
      notes.push(
        `Area code ${area} dials like a US number but is international. It features in regulator warnings about lottery and "one ring" callback scams.`,
      );
    }
    if (/^(800|833|844|855|866|877|888)$/.test(area))
      notes.push('Toll-free number: the favourite of fake "support line" scams.');
  } else {
    for (const size of [3, 2, 1]) {
      const code = CALLING_CODES[digits.slice(0, size)];
      if (code) {
        country = code;
        break;
      }
    }
  }
  return { phone, country, countryName: country ? countryName(country) : null, notes };
};

// What an email address says about itself
export const emailInfo = (value) => {
  const email = String(value || '')
    .trim()
    .toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[a-z]{2,24}$/.test(email)) return null;
  const domain = email.slice(email.indexOf('@') + 1);
  const yahoo = /^yahoo\.[a-z.]{2,6}$/.test(domain);
  let provider = 'own-domain';
  if (THROWAWAY_MAIL.has(domain)) provider = 'throwaway';
  else if (FREE_MAIL.has(domain) || yahoo) provider = 'free-webmail';
  const notes = {
    throwaway: 'A disposable mailbox: nobody stands behind it.',
    'free-webmail': 'A free webmail account. Real organisations write from their own domain.',
    'own-domain': `Uses its own domain (${domain}), which can be investigated like any other site.`,
  };
  return { email, domain, provider, notes: [notes[provider]] };
};

// Has a spam-report service seen this address before?
const spamReports = async (ctx, email) => {
  try {
    const data = await ctx.cachedJson(
      `https://api.stopforumspam.org/api?json&email=${encodeURIComponent(email)}`,
      { ttl: TTL.rdap, timeoutMs: 12000 },
    );
    const record = data.email || {};
    return {
      reported: Boolean(record.appears),
      reports: record.frequency || 0,
      lastSeen: record.lastseen || null,
    };
  } catch (error) {
    ctx.noteError('stopforumspam', error);
    return null;
  }
};

// Which known breaches include this address. Uses Have I Been Pwned with the caller's own
// key, and returns breach names and dates only, never the leaked data itself
const breachExposure = async (ctx, email) => {
  const key = process.env.HIBP_API_KEY;
  if (!key) {
    return {
      skipped:
        'Set HIBP_API_KEY to check breach exposure (haveibeenpwned.com/API/Key). To check your own address without a key, use haveibeenpwned.com.',
    };
  }
  try {
    const response = await ctx.fetch(
      `https://haveibeenpwned.com/api/v3/breachedaccount/${encodeURIComponent(email)}?truncateResponse=false`,
      {
        headers: { 'hibp-api-key': key },
        timeoutMs: 15000,
      },
    );
    if (response.status === 404) return { breaches: [] };
    if (!response.ok) return { error: `Have I Been Pwned answered HTTP ${response.status}` };
    return {
      breaches: response.json().map((breach) => ({
        name: breach.Title || breach.Name,
        date: breach.BreachDate,
        exposed: breach.DataClasses,
      })),
    };
  } catch (error) {
    return { error: error.message };
  }
};

export const CAVEAT =
  'A contact on a scam page is often a hijacked, spoofed or throwaway account. Treat this as a lead about the scam, not as the identity of a person.';

// Everything known about one contact point. `online` adds the two reputation lookups
export const describeContact = async (ctx, value, { online = false } = {}) => {
  const text = String(value || '').trim();
  const email = emailInfo(text);
  if (email) {
    const result = { kind: 'email', ...email, caveat: CAVEAT };
    if (online && ctx) {
      result.spamReports = await spamReports(ctx, email.email);
      result.breachExposure = await breachExposure(ctx, email.email);
    }
    return result;
  }
  const phone = phoneInfo(text);
  if (phone) {
    return {
      kind: 'phone',
      ...phone,
      breachExposure: {
        skipped:
          'No public service checks phone numbers against breaches, so this is not attempted.',
      },
      caveat: CAVEAT,
    };
  }
  return null;
};
