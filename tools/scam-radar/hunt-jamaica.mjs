// The Jamaica hunt: look for scam sites aimed at people in Jamaica and put them on Radar's watchlist.
//
//   node tools/scam-radar/hunt-jamaica.mjs --hunt FILE [--minutes 8]   search, and write the leads to FILE
//   node tools/scam-radar/hunt-jamaica.mjs --add FILE [--db DB]        put FILE's leads on the watchlist
//
// The scan workflow starts --hunt in the background at the start of each hourly run, while the scan
// goes on, and runs --add between two scan cycles once FILE is there. The two halves are separate so
// only one process writes to Radar's database at a time.
//
// --hunt runs Scam Finder's hunt with two of its saved profiles. "jamaica": hostnames and page titles
// that borrow a Jamaican bank, telecom or agency on someone else's domain, pages pairing "Jamaica" with
// prize, grant or sign-in wording, holiday giveaway lures, and the WhatsApp gift kit where it targets
// Jamaica. "lottery": lottery-winner titles on young domains, sweepstakes names on domains that are not
// theirs, and advance-fee wording. It searches urlscan.io's public scan archive and the blocklist feeds,
// visits the most suspicious leads and scores every lead on its own evidence. Being Jamaican never makes
// a site suspect.
//
// --add puts the leads that scored medium or higher, and still answer, on the watchlist, first in line,
// so the next cycles visit them. Radar names a site only on its own strong evidence, as for every other
// site. It also keeps jamaica-hunt.json next to the database: when each hunt ran and what it found, in
// counts. export.mjs publishes those counts.
import fs from 'node:fs';
import path from 'node:path';
import { hunt } from './scam-finder/lib/investigate.js';
import { watch } from './scam-finder/lib/radar/daemon.js';
import { RadarStore, defaultDbPath } from './scam-finder/lib/radar/store.js';

const PROFILES = ['jamaica', 'lottery'];
const WHY = 'Jamaica hunt';
const KEEP_LEVELS = new Set(['medium', 'high', 'critical']);
const MAX_ADD = 150;
const HISTORY = 48;

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const writeAtomic = (file, value) => {
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value));
  fs.renameSync(temp, file);
};

// What --hunt writes: the leads and a summary. It stays on the runner and is never published.
const huntNow = async (file, minutes) => {
  const started = Date.now();
  const result = await hunt({ profiles: PROFILES }, {
    depth: 1,
    maxPivots: 14,
    maxDomains: 600,
    maxResultsPerPivot: 300,
    pages: 40,
    rdap: 20,
    feeds: 'default',
    timeBudgetMs: minutes * 60000,
    onProgress: ({ stage, message }) => console.log(`[${stage}] ${message}`),
  });
  const leads = (result.domains || []).map((d) => ({
    name: d.domain,
    level: d.risk?.level || 'low',
    score: d.risk?.score || 0,
    state: d.state || 'unknown',
    jamaica: (d.targets || []).some((t) => t.country === 'JM'),
    kits: (d.kits || []).length,
  }));
  const searches = (result.pivots || []).map(({ type, why, status, total, kept }) => ({ type, why, status, total: total ?? null, kept: kept ?? null }));
  writeAtomic(file, {
    at: new Date().toISOString(),
    seconds: Math.round((Date.now() - started) / 1000),
    profiles: PROFILES,
    searches,
    errors: (result.sources?.errors || []).length,
    leads,
  });
  console.log(`Hunt done in ${Math.round((Date.now() - started) / 1000)} s: ${searches.length} searches, ${leads.length} leads, `
    + `${leads.filter((l) => KEEP_LEVELS.has(l.level)).length} medium or higher, ${leads.filter((l) => l.jamaica).length} aimed at Jamaica`);
  for (const s of searches) console.log(`  ${s.status} ${s.type}: ${s.why} (${s.total ?? '?'} found, ${s.kept ?? '?'} kept)`);
};

const addNow = async (file, dbFile) => {
  const found = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!fs.existsSync(dbFile)) throw new Error(`No Radar database at ${dbFile}`);
  const keep = (found.leads || [])
    .filter((lead) => KEEP_LEVELS.has(lead.level) && lead.state !== 'offline' && /^[a-z0-9.-]+\.[a-z0-9-]{2,}$/i.test(lead.name || ''))
    .sort((a, b) => b.jamaica - a.jamaica || b.score - a.score)
    .slice(0, MAX_ADD);
  const store = await RadarStore.open(dbFile);
  let added = 0;
  try {
    const names = keep.map((lead) => lead.name.toLowerCase());
    added = names.length ? watch(store, names, `${WHY}: ${found.profiles.join(' and ')} searches`) : 0;
    // First in line, like prioritize.mjs does for brand look-alikes; only for sites not yet visited
    const first = store.prepare('UPDATE sites SET next_check = 0 WHERE name = ? AND checks = 0');
    for (const name of names) first.run(name);
  } finally {
    store.close();
  }
  const summary = {
    at: found.at,
    seconds: found.seconds,
    searches: (found.searches || []).filter((s) => s.type === 'query' && s.status === 'ok').length,
    keywords: (found.searches || []).filter((s) => s.type === 'keyword').length,
    leads: (found.leads || []).length,
    suspect: (found.leads || []).filter((lead) => KEEP_LEVELS.has(lead.level)).length,
    aimedAtJamaica: (found.leads || []).filter((lead) => lead.jamaica).length,
    added,
  };
  const historyFile = path.join(path.dirname(dbFile), 'jamaica-hunt.json');
  let history = [];
  try {
    history = JSON.parse(fs.readFileSync(historyFile, 'utf8'));
    if (!Array.isArray(history)) history = [];
  } catch {
    history = [];
  }
  // The same hunt added twice (a retried step) counts what both added
  const before = history.find((h) => h.at === summary.at);
  if (before) summary.added += before.added || 0;
  history = [...history.filter((h) => h.at !== summary.at), summary].slice(-HISTORY);
  writeAtomic(historyFile, history);
  console.log(`Jamaica hunt from ${summary.at}: ${keep.length} leads kept, ${added} new on the watchlist`);
};

const huntFile = flag('--hunt', null);
const addFile = flag('--add', null);
try {
  if (huntFile) await huntNow(huntFile, Math.min(20, Math.max(1, Number(flag('--minutes', 8)) || 8)));
  else if (addFile) await addNow(addFile, flag('--db', defaultDbPath()));
  else {
    console.error('Give --hunt FILE or --add FILE');
    process.exit(2);
  }
} catch (error) {
  console.error(`The Jamaica hunt stopped: ${error.message}`);
  process.exit(1);
}
