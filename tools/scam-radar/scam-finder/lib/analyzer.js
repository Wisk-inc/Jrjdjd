// Static code analysis: read a page's HTML and JavaScript as text and report what it is
// built to do. Nothing is ever executed
//
// Scam pages hide their working parts behind layers of encoding, so the first step is to
// peel those layers (base64, URL-escapes, character-code lists, hex strings) and read
// what is underneath. A behaviour found only under the wrapping is flagged as hidden

import { BRANDS } from '../data/brands.js';
import { isOfficialDomain, isWellKnown } from './heuristics.js';
import { cleanHost, registrableDomain } from './util.js';

const MAX_SOURCE = 800 * 1024;
const MAX_HIDDEN = 300 * 1024;

const printable = (text) => {
  if (!text) return false;
  let ok = 0;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code === 9 || code === 10 || code === 13 || (code >= 32 && code < 127) || code > 159)
      ok += 1;
  }
  return ok / text.length >= 0.85;
};

// Each decoder finds one way of hiding text in a script and returns what was hidden
const DECODERS = [
  [
    /atob\(\s*['"`]([A-Za-z0-9+/=]{8,20000})['"`]\s*\)/g,
    (match) => Buffer.from(match[1], 'base64').toString('utf8'),
  ],
  [
    /(?:unescape|decodeURIComponent|decodeURI)\(\s*['"`]((?:%u[0-9a-fA-F]{4}|%[0-9a-fA-F]{2}|[^'"`%\\]){8,20000})['"`]/g,
    (match) =>
      match[1].replace(/%u([0-9a-fA-F]{4})|%([0-9a-fA-F]{2})/g, (whole, wide, narrow) =>
        String.fromCharCode(parseInt(wide || narrow, 16)),
      ),
  ],
  [
    /String\.fromCharCode\(\s*((?:\d{1,6}\s*,\s*){5,4000}\d{1,6})\s*\)/g,
    (match) =>
      String.fromCharCode(...match[1].split(',').map((part) => Number(part.trim()) & 0xffff)),
  ],
  [
    /['"`]((?:\\x[0-9a-fA-F]{2}|\\u[0-9a-fA-F]{4}){6,8000})['"`]/g,
    (match) =>
      match[1].replace(/\\x([0-9a-fA-F]{2})|\\u([0-9a-fA-F]{4})/g, (whole, narrow, wide) =>
        String.fromCharCode(parseInt(narrow || wide, 16)),
      ),
  ],
];

// Peel encoded strings out of a script, then look inside what came out, twice over
export const unpack = (source) => {
  const found = [];
  let layers = 0;
  let size = 0;
  let current = source;
  for (let depth = 0; depth < 2 && size < MAX_HIDDEN; depth += 1) {
    const round = [];
    for (const [pattern, decode] of DECODERS) {
      for (const match of current.matchAll(pattern)) {
        let text;
        try {
          text = decode(match);
        } catch {
          continue;
        }
        if (text.length < 4 || !printable(text)) continue;
        round.push(text);
        size += text.length;
        if (size >= MAX_HIDDEN) break;
      }
    }
    if (!round.length) break;
    layers = depth + 1;
    found.push(...round);
    current = round.join('\n');
  }
  return { hidden: found.join('\n').slice(0, MAX_HIDDEN), layers, strings: found.length };
};

const count = (source, pattern) => (source.match(pattern) || []).length;

// A short quote of the code around a match, for the report
const quote = (source, match) => {
  const start = Math.max(0, match.index - 24);
  return source
    .slice(start, match.index + Math.min(match[0].length, 90) + 24)
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 150);
};

// Sectors where borrowing the real organisation's images is a classic phishing tell
const SENSITIVE = new Set([
  'bank',
  'payments',
  'crypto',
  'delivery',
  'government',
  'telecom',
  'lottery',
]);
const sensitiveBrands = BRANDS.filter((brand) => SENSITIVE.has(brand.sector));

const FORWARDERS =
  /formspree\.io|formsubmit\.co|getform\.io|formcarry\.com|web3forms\.com|emailjs\.com|usebasin\.com|formbold\.com|submit-form\.com|script\.google\.com/i;

// What to look for. `find(c)` returns evidence (a string) when the behaviour is present.
// `c.see(pattern)` searches the page and then the unpacked code, remembering which
const RULES = [
  {
    id: 'exfil-telegram',
    severity: 3,
    category: 'phishing',
    label: 'Sends what visitors type to a Telegram bot',
    find: (c) =>
      c.see(/api\.telegram\.org\/bot\d{6,12}:[\w-]{20,}/i)?.replace(/(bot\d{6,12}):[\w-]+/, '$1:…'),
  },
  {
    id: 'exfil-discord',
    severity: 3,
    category: 'phishing',
    label: 'Sends data to a Discord webhook',
    find: (c) => c.see(/discord(?:app)?\.com\/api\/webhooks\/\d+/i),
  },
  {
    id: 'form-forwarder',
    severity: 2,
    category: 'phishing',
    label: 'Posts passwords or card details to a form-forwarding service',
    find: (c) => {
      if (!c.forms.passwordFields && !c.forms.cardFields) return null;
      return c.forms.actionHosts.find((host) => FORWARDERS.test(host)) || c.see(FORWARDERS);
    },
  },
  {
    id: 'keylogger',
    severity: 2,
    category: 'phishing',
    label: 'Records keystrokes and sends them elsewhere',
    find: (c) =>
      c.see(
        /addEventListener\(\s*['"]key(?:down|press|up)['"][\s\S]{0,700}?(?:fetch\(|XMLHttpRequest|sendBeacon|new Image|WebSocket)/,
      ),
  },
  {
    id: 'one-time-code',
    severity: 2,
    category: 'phishing',
    label: 'Asks for a one-time passcode',
    find: (c) =>
      c.forms.count || /<input/i.test(c.html)
        ? c.see(
            /(?:one[- ]time|\botp\b|verification|\bsms\b|\b2fa\b|authenticat\w+)[ -]?(?:code|password|passcode|pin)\b/i,
          )
        : null,
  },
  {
    id: 'brand-assets',
    severity: 2,
    category: 'phishing',
    label: "Borrows images or styles from a real organisation's website",
    find: (c) => {
      for (const host of c.externalHosts) {
        const brand = sensitiveBrands.find((item) => isOfficialDomain(item, host));
        if (brand && !isOfficialDomain(brand, c.host)) return `${host} (${brand.name})`;
      }
      return null;
    },
  },
  {
    id: 'seed-phrase',
    severity: 3,
    category: 'crypto',
    label: 'Asks for a crypto wallet recovery phrase or private key',
    find: (c) =>
      /<(?:input|textarea)/i.test(c.html)
        ? c.see(
            /(?:seed|recovery|secret|mnemonic)[ -]?phrase|\b(?:12|24)[ -]?words?\b.{0,30}(?:phrase|seed|wallet)|enter (?:your )?private key/i,
          )
        : null,
  },
  {
    id: 'wallet-approval',
    severity: 3,
    category: 'crypto',
    label: 'Asks a crypto wallet to sign away control of its funds',
    find: (c) =>
      c.see(/walletconnect|web3modal|window\.ethereum|ethers\.|tronweb|solana|phantom|wagmi/i)
        ? c.see(
            /setApprovalForAll|increaseAllowance|eth_signTypedData_v4|signAllTransactions|\bpermit2?\s*\(|eth_sendTransaction/,
          )
        : null,
  },
  {
    id: 'drainer-kit',
    severity: 3,
    category: 'crypto',
    label: 'Contains a known wallet-drainer kit',
    find: (c) =>
      c.see(
        /(?:inferno|angel|pink|monkey|venom|medusa|chick)[ _-]?drainer|drainer[ _-]?(?:config|script|kit)\b/i,
      ),
  },
  {
    id: 'clipboard-command',
    severity: 3,
    category: 'malware',
    label: 'Copies a system command to the clipboard for the visitor to run',
    find: (c) =>
      c.see(/clipboard\.writeText|execCommand\(\s*['"]copy/i)
        ? c.see(
            /powershell|mshta\b|cmd(?:\.exe)?\s*\/c|\biex\b|Invoke-(?:WebRequest|Expression|RestMethod)|curl\s[^|"']{0,80}\|\s*(?:ba)?sh|regsvr32|rundll32/i,
          )
        : null,
  },
  {
    id: 'fake-update',
    severity: 3,
    category: 'malware',
    label: 'Fake browser or software update that offers a download',
    find: (c) =>
      c.see(
        /(?:update|upgrade|outdated|out of date).{0,40}(?:browser|chrome|firefox|edge|safari|flash player|font pack)/i,
      ) &&
      c.see(
        /(?:href|download)\s*=\s*["'][^"']{0,300}\.(?:exe|msi|msix|zip|js|vbs|scr|iso|lnk|hta|bat|ps1|dmg)\b/i,
      ),
  },
  {
    id: 'app-sideload',
    severity: 2,
    category: 'malware',
    label: 'Offers an Android app from outside the app store',
    find: (c) => c.see(/href\s*=\s*["'][^"']{0,300}\.apk\b/i),
  },
  {
    id: 'browser-miner',
    severity: 3,
    category: 'malware',
    label: "Mines cryptocurrency in the visitor's browser",
    find: (c) =>
      c.see(
        /coinhive|coin-hive|cryptonight|crypto-?loot|jsecoin|webminepool|coinimp|minero\.cc|deepminer|stratum\+tcp/i,
      ),
  },
  {
    id: 'card-skimmer',
    severity: 3,
    category: 'malware',
    label: 'Copies payment card fields and sends them to another server',
    find: (c) =>
      c.see(/(?:cc|card)[-_ ]?(?:num|number)|\bcvv\b|\bcvc\b/i) && c.see(/\bbtoa\(|JSON\.stringify/)
        ? c.see(
            /new Image\(\)\.src\s*=|navigator\.sendBeacon\(\s*['"]https?:\/\/|\.src\s*=\s*['"]https?:\/\/[^'"]{0,120}\?(?:[^'"]{0,40})?(?:data|d|c|cc)=/,
          )
        : null,
  },
  {
    id: 'hidden-frame',
    severity: 2,
    category: 'malware',
    label: 'Loads another site in an invisible frame',
    find: (c) => {
      const pattern =
        /<iframe[^>]{0,400}(?:(?:width|height)\s*=\s*["']?[01](?:px)?["'\s>]|display\s*:\s*none|visibility\s*:\s*hidden|opacity\s*:\s*0[;"'\s])[^>]{0,400}>/gi;
      for (const [text, hidden] of [
        [c.html, false],
        [c.hiddenSource, true],
      ]) {
        for (const frame of text.matchAll(pattern)) {
          const src = frame[0].match(/\ssrc\s*=\s*["']?(?:https?:)?\/\/([^/"'\s>]+)/i);
          if (!src) continue;
          // Tag managers, payment widgets and the like use hidden frames all the time
          const host = cleanHost(src[1]);
          if (isWellKnown(host) || registrableDomain(host) === registrableDomain(c.host)) continue;
          return { evidence: `invisible frame from ${host}`, hidden };
        }
      }
      return null;
    },
  },
  {
    id: 'browser-trap',
    severity: 3,
    category: 'tech-support',
    label: 'Tries to trap the visitor in the page',
    find: (c) => {
      const tricks = [
        /requestFullscreen|webkitRequestFullScreen|mozRequestFullScreen/i,
        /onbeforeunload|['"]beforeunload['"]/,
        /setInterval\([^)]{0,80}alert\s*\(|while\s*\(\s*(?:true|1)\s*\)\s*\{[^}]{0,80}alert/,
        /keyCode\s*={2,3}\s*(?:27|122|123)|['"]F11['"]|['"]Escape['"]/,
      ].filter((pattern) => c.see(pattern));
      return tricks.length >= 3 ? `${tricks.length} of 4 page-locking tricks` : null;
    },
  },
  {
    id: 'notification-bait',
    severity: 2,
    category: 'adware',
    label: 'Tricks visitors into allowing notifications',
    find: (c) =>
      c.see(/Notification\.requestPermission|pushManager\.subscribe/) &&
      c.see(
        /(?:click|press|tap)\s+["“'‘]?allow["”'’]?\s+(?:to|if)|allow notifications to (?:continue|watch|verify|download)/i,
      ),
  },
  {
    id: 'run-hidden-code',
    severity: 2,
    category: 'evasion',
    label: 'Runs code that stays encoded until the page loads',
    find: (c) =>
      c.see(
        /\b(?:eval|Function)\s*\(\s*(?:atob|unescape|decodeURIComponent)\s*\(|document\.write(?:ln)?\s*\(\s*(?:atob|unescape|decodeURIComponent)\s*\(|eval\(function\(p,a,c,k,e,[dr]\)/,
      ),
  },
  {
    id: 'data-page',
    severity: 2,
    category: 'evasion',
    label: 'Builds the page from an embedded document, which hides it from link scanners',
    find: (c) =>
      c.see(/(?:location(?:\.href)?\s*=|window\.open\(|\.src\s*=)\s*["'`]data:text\/html/i),
  },
  {
    id: 'referrer-gate',
    severity: 2,
    category: 'evasion',
    label: 'Shows different content depending on where the visitor came from',
    find: (c) =>
      c.see(
        /document\.referrer[\s\S]{0,240}?(?:google|bing|yahoo|yandex|facebook|instagram|tiktok)[\s\S]{0,300}?location/i,
      ),
  },
  {
    id: 'automation-check',
    severity: 1,
    category: 'evasion',
    label: 'Checks whether it is being viewed by a scanner',
    find: (c) =>
      c.see(/navigator\.webdriver|HeadlessChrome|phantomjs|callPhantom|__nightmare|puppeteer/i),
  },
  {
    id: 'inspection-blocked',
    severity: 1,
    category: 'evasion',
    label: 'Disables right-click or the keys that open developer tools',
    find: (c) =>
      c.see(
        /['"]contextmenu['"][\s\S]{0,160}?preventDefault|oncontextmenu\s*=\s*["']?return false/i,
      ) && c.see(/keyCode\s*={2,3}\s*123|['"]F12['"]/),
  },
  {
    id: 'obfuscated-script',
    severity: 1,
    category: 'evasion',
    label: 'Script has been run through an obfuscator',
    find: (c) => {
      const names = count(c.source, /_0x[a-f0-9]{4,6}\b/g);
      return names >= 25 ? `${names} scrambled names` : null;
    },
  },
  {
    id: 'investment-pitch',
    severity: 2,
    category: 'investment',
    label: 'Reads like a fake investment or paid-task platform',
    find: (c) => {
      const cues = [
        /\bVIP ?\d\b/,
        /\b(?:recharge|top[- ]?up) (?:now|amount|record|bonus)\b/i,
        /\b(?:daily|per day) (?:income|profit|earnings?|returns?|commission)\b/i,
        /\bgrab (?:an? )?orders?\b|\btask (?:hall|center|commission)\b/i,
        /\b(?:invite|referral|team) (?:bonus|commission|rebate|reward)s?\b/i,
        /\bwithdraw(?:al)? (?:record|password|now)\b/i,
        /\bguaranteed (?:profit|returns?|income)\b|\b\d{1,3}% (?:daily|per day|weekly)\b/i,
      ].filter((pattern) => pattern.test(c.text));
      return cues.length >= 3
        ? `${cues.length} platform phrases, such as "${c.text.match(cues[0])[0]}"`
        : null;
    },
  },
  {
    id: 'pressure',
    severity: 1,
    category: 'pressure',
    label: 'Rushes the visitor with a countdown or shrinking stock',
    find: (c) =>
      c.seeText(
        /only \d+ (?:gifts?|prizes?|items?|spots?|left|remaining)|offer (?:ends|expires) in|\bhurry\b.{0,40}\b(?:left|remaining|ends)\b/i,
      ),
  },
];

const WEIGHT = { 3: 0.6, 2: 0.35, 1: 0.12 };
export const findingWeight = (finding) => WEIGHT[finding.severity] || 0.1;

// Read a page's code and list what it is built to do, most serious first
export const analyzeCode = ({
  html = '',
  text = '',
  host = '',
  externalHosts = [],
  forms = {},
  isListed,
} = {}) => {
  const source = String(html).slice(0, MAX_SOURCE);
  const unpacked = unpack(source);
  let lastHidden = false;
  const context = {
    html: source,
    source: `${source}\n${unpacked.hidden}`,
    hiddenSource: unpacked.hidden,
    text: String(text || ''),
    host: cleanHost(host),
    externalHosts,
    forms: { count: 0, passwordFields: 0, cardFields: 0, actionHosts: [], ...forms },
    // Look in the page as served first; only then in what was hidden inside it
    see(pattern) {
      const open = pattern.exec(source);
      pattern.lastIndex = 0;
      if (open) return quote(source, open);
      const veiled = pattern.exec(unpacked.hidden);
      pattern.lastIndex = 0;
      if (!veiled) return null;
      lastHidden = true;
      return quote(unpacked.hidden, veiled);
    },
    seeText(pattern) {
      const match = pattern.exec(this.text);
      return match ? quote(this.text, match) : null;
    },
  };

  const findings = [];
  for (const rule of RULES) {
    lastHidden = false;
    let evidence = null;
    try {
      evidence = rule.find(context);
    } catch {
      // One misbehaving rule must not lose the rest of the analysis
    }
    if (!evidence) continue;
    // A rule may answer with plain evidence, or say for itself whether it was hidden
    const own = typeof evidence === 'object';
    findings.push({
      id: rule.id,
      severity: rule.severity,
      category: rule.category,
      label: rule.label,
      evidence: String(own ? evidence.evidence : evidence),
      ...((own ? evidence.hidden : lastHidden) ? { hidden: true } : {}),
    });
  }

  // Scripts served from hosts that are already on a blocklist
  if (isListed) {
    const scripts = [
      ...source.matchAll(/<script[^>]{0,400}\ssrc\s*=\s*["']?(https?:)?\/\/([^/"'\s>]+)/gi),
    ].map((match) => cleanHost(match[2]));
    const listed = [...new Set(scripts)].filter(
      (name) => registrableDomain(name) !== registrableDomain(context.host) && isListed(name),
    );
    if (listed.length) {
      findings.push({
        id: 'listed-script',
        severity: 3,
        category: 'malware',
        label: 'Loads a script from a blocklisted host',
        evidence: listed.slice(0, 3).join(', '),
      });
    }
  }

  findings.sort((a, b) => b.severity - a.severity);
  return { findings, layers: unpacked.layers, hiddenStrings: unpacked.strings };
};
