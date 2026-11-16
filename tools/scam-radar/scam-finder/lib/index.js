// Public entry point for the scam finder
//
//   import { investigate, hunt } from './scam-finder/lib/index.js';
//   const result = await investigate('https://suspicious.example/path', { depth: 1 });
//
// `investigate` maps what one suspect site is connected to; `hunt` collects fresh leads
// from saved profiles or raw queries. Both return the same plain-JSON result shape

export { DEFAULTS, QUICK, hunt, investigate } from './investigate.js';
export { describeShape, toGraph } from './graph.js';
export { LEVELS, LINK_LABELS, levelFor, scoreProfile } from './score.js';
export { FEEDS, FEED_PRESETS } from './sources/feeds.js';
export { defang, parseTarget, refang } from './util.js';
export { PROFILES, PROFILE_IDS } from '../data/profiles.js';
export { SIGNATURES } from '../data/signatures.js';
