// Name-only triage: judge a domain from its spelling alone, with no network at all
//
// This is what makes millions of names tractable on a small machine. Each name costs about
// a microsecond, and only the few that look wrong go on to be resolved and visited

import { BRANDS } from '../../data/brands.js';
import { COMMON_PAIRS, RISKY_TLDS } from '../heuristics.js';

// Letter pairs as a 26x26 table, so the inner loop is two array reads per character
const PAIRS = new Uint8Array(26 * 26);
for (const pair of COMMON_PAIRS) {
  PAIRS[(pair.charCodeAt(0) - 97) * 26 + (pair.charCodeAt(1) - 97)] = 1;
}
const VOWEL = new Uint8Array(26);
for (const letter of 'aeiou') VOWEL[letter.charCodeAt(0) - 97] = 1;

const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// One pattern for every brand token: long ones anywhere, short ones only as a whole part
const longTokens = [];
const shortTokens = [];
for (const brand of BRANDS) {
  for (const token of brand.tokens) {
    const word = token.replace(/-$/, '');
    if (word.length >= 5 && word === token) longTokens.push(escape(word));
    else shortTokens.push(escape(word));
  }
}
const BRAND_PATTERN = new RegExp(
  `${[...new Set(longTokens)].join('|')}|(?:^|[.-])(?:${[...new Set(shortTokens)].join('|')})(?=$|[.-])`,
);
const OFFICIAL = new Set(BRANDS.flatMap((brand) => brand.domains));
const OFFICIAL_SUFFIXES = [...OFFICIAL].map((domain) => `.${domain}`);

// Words that turn up in the names of scam sites far more than in honest ones
const BAIT_PATTERN =
  /log-?in|sign-?in|verif|secur|account|update|unlock|suspend|billing|wallet|airdrop|claim|bonus|gift|prize|winner|lott|giveaway|reward|refund|recover|support|helpdesk|parcel|deliver|track|customs|subsid|grant|relief|invest|profit|trading|mining|loan|payout|cashapp|whatsapp|telegram|free/g;

const isOfficial = (domain) => {
  if (OFFICIAL.has(domain)) return true;
  for (const suffix of OFFICIAL_SUFFIXES) if (domain.endsWith(suffix)) return true;
  return false;
};

// Does a label read like a word, or like something a script generated?
export const looksRandom = (label) => {
  let letters = 0;
  let vowels = 0;
  let pairs = 0;
  let common = 0;
  let run = 0;
  let longestRun = 0;
  let digits = 0;
  let previous = -1;
  for (let i = 0; i < label.length; i += 1) {
    const code = label.charCodeAt(i);
    if (code >= 97 && code <= 122) {
      const letter = code - 97;
      letters += 1;
      if (VOWEL[letter]) {
        vowels += 1;
        run = 0;
      } else {
        run += 1;
        if (run > longestRun) longestRun = run;
      }
      if (previous >= 0) {
        pairs += 1;
        common += PAIRS[previous * 26 + letter];
      }
      previous = letter;
    } else if (code >= 48 && code <= 57) {
      digits += 1;
    }
  }
  if (letters < 5) return false;
  const pairRatio = pairs ? common / pairs : 1;
  return (
    pairRatio < 0.45 ||
    longestRun >= 4 ||
    (letters >= 6 && vowels / letters < 0.2) ||
    (digits >= 3 && digits / label.length > 0.3 && pairRatio < 0.7)
  );
};

// The mould a name was cast from: "letters5.buzz" for any five letters dot buzz
export const shapeOf = (domain) => {
  const dot = domain.indexOf('.');
  if (dot <= 0) return null;
  const label = domain.slice(0, dot);
  let kind = 'mixed';
  if (/^[a-z]+$/.test(label)) kind = 'letters';
  else if (/^\d+$/.test(label)) kind = 'digits';
  else if (/^[a-z0-9]+$/.test(label)) kind = 'alnum';
  else if (/^[a-z0-9-]+$/.test(label)) kind = 'hyphenated';
  return `${kind}${label.length}${domain.slice(dot)}`;
};

// Score a registrable domain 0-60 on spelling alone, with the reasons as short tags
export const nameScore = (domain, wantReasons = false) => {
  const dot = domain.indexOf('.');
  const label = dot > 0 ? domain.slice(0, dot) : domain;
  const tld = domain.slice(domain.lastIndexOf('.') + 1);
  let score = 0;
  const reasons = wantReasons ? [] : null;

  const brand = BRAND_PATTERN.test(domain) && !isOfficial(domain);
  if (brand) {
    score += 35;
    reasons?.push('borrows a brand name');
  }
  const bait = domain.match(BAIT_PATTERN);
  if (bait) {
    const distinct = new Set(bait).size;
    score += distinct > 1 || brand ? 18 : 8;
    reasons?.push(
      `bait word${distinct > 1 ? 's' : ''} (${[...new Set(bait)].slice(0, 3).join(', ')})`,
    );
  }
  if (RISKY_TLDS.has(tld)) {
    score += 8;
    reasons?.push(`.${tld}`);
  }
  if (looksRandom(label)) {
    score += 10;
    reasons?.push('machine-made name');
  }
  if (label.startsWith('xn--')) {
    score += 8;
    reasons?.push('look-alike characters');
  }
  let hyphens = 0;
  let digits = 0;
  for (let i = 0; i < label.length; i += 1) {
    const code = label.charCodeAt(i);
    if (code === 45) hyphens += 1;
    else if (code >= 48 && code <= 57) digits += 1;
  }
  if (hyphens >= 2 || digits >= 4 || label.length >= 25) score += 4;
  score = Math.min(60, score);
  return wantReasons ? { score, reasons } : score;
};
