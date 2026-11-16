// The parts of Scam Finder that need no network, bundled for the browser as
// /assets/js/scam-finder-core.js (see build-bundles.mjs). The page uses them to judge an address
// from its spelling and shape, with the same code and the same weights the scanner uses.
import { describeShape } from './scam-finder/lib/graph.js';
import { findBrands, isWellKnown, lexical, urlShape } from './scam-finder/lib/heuristics.js';
import { nameScore, shapeOf } from './scam-finder/lib/radar/triage.js';
import { LEVELS, levelFor, scoreProfile } from './scam-finder/lib/score.js';
import { defang, hostingPlatform, isLocalName, isPrivateIp, parseTarget, refang } from './scam-finder/lib/util.js';

// Everything that can be said about a link without visiting it
export const judge = (input) => {
  const target = parseTarget(input); // throws a readable Error when the input is not a link or domain
  if (isLocalName(target.host) || (target.isIp && isPrivateIp(target.host))) {
    throw new Error('That address is private or local, so there is nothing public to check');
  }
  const brands = findBrands({ title: '', text: '', host: target.host });
  const official = brands.filter((brand) => brand.official).map((brand) => brand.name);
  const borrowed = brands.filter((brand) => !brand.official && brand.inDomain).map((brand) => brand.name);
  const wellKnown = isWellKnown(target.host);
  const profile = {
    domain: target.domain,
    role: 'seed',
    wellKnown,
    lexical: lexical(target.host),
    urlShape: target.hasPath ? urlShape(target.url) : null,
    brands,
    kits: [],
    lures: [],
    findings: [],
    blocklists: [],
  };
  const risk = scoreProfile(profile);
  const triage = target.isIp ? { score: 0, reasons: [] } : nameScore(target.domain, true);
  const shape = target.isIp ? null : shapeOf(target.domain);
  // Names Radar may hold this site under: the host itself, then each parent down to the registered domain
  const labels = target.host.split('.');
  const names = [];
  if (!target.isIp) {
    for (let i = 0; i <= labels.length - 2; i += 1) {
      const name = labels.slice(i).join('.');
      names.push(name);
      if (name === target.domain) break;
    }
  }
  return {
    input: target.input,
    url: target.url,
    host: target.host,
    domain: target.domain,
    shown: defang(target.domain),
    hasPath: target.hasPath,
    isIp: target.isIp,
    names,
    wellKnown,
    official,
    borrowed,
    platform: hostingPlatform(target.host),
    score: risk.score,
    level: risk.level,
    signals: (risk.signals || []).map(({ id, label }) => ({ id, label })),
    mitigations: risk.mitigations || [],
    nameScore: triage.score,
    nameReasons: triage.reasons,
    // Only the moulds scripts really use: a run of letters, digits or both, with no words in it
    mould: shape && /^(letters|digits|alnum)\d/.test(shape) ? describeShape(shape) : null,
    looksRandom: Boolean(profile.lexical?.randomLooking),
  };
};

export { LEVELS, defang, levelFor, refang };
