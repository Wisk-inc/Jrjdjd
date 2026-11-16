// Finding scam factories from names alone
//
// Throwaway scam domains are registered in bulk by a script, so they share a mould: the
// same length, the same alphabet, the same cheap ending ("five random letters .buzz").
// Honest registrations of that shape are rare. So for every shape, compare how common it
// is among brand-new names with how common it is across the established web. A shape that
// is suddenly many times over-represented, and mostly unpronounceable, is a batch
//
// It costs nothing but arithmetic over names already in the index, and it surfaces sites
// that no scanner has visited and no blocklist has listed yet

import { SRC } from './store.js';
import { looksRandom, shapeOf } from './triage.js';

// Shapes whose new registrations are far out of line with the established web
export const detectCohorts = (store, { minRandom = 15, minShare = 0.4, minLift = 8 } = {}) => {
  const totals = store.prepare('SELECT sum(base) AS base, sum(fresh) AS fresh FROM shapes').get();
  if (!totals?.fresh) return [];
  const cohorts = [];
  for (const row of store.shapes(minRandom)) {
    // Only short, script-like labels: letters or letters-and-digits, not phrases
    if (!/^(letters|alnum|digits)\d+\./.test(row.shape)) continue;
    const share = row.random / row.fresh;
    const lift = row.fresh / totals.fresh / ((row.base + 1) / (totals.base + 1));
    if (share < minShare || lift < minLift) continue;
    cohorts.push({
      shape: row.shape,
      size: row.fresh,
      random: row.random,
      established: row.base,
      lift: Number(lift.toFixed(1)),
    });
  }
  return cohorts.sort((a, b) => b.random * Math.log2(b.lift) - a.random * Math.log2(a.lift));
};

// Tag every new name cast from a flagged mould, which queues it for a visit
export const markCohorts = (store, cohorts, { limit = 60 } = {}) => {
  const wanted = new Map(
    cohorts.slice(0, limit).map((cohort) => [cohort.shape, { ...cohort, members: [] }]),
  );
  if (!wanted.size) return [];
  for (const name of store.freshNames()) {
    const cohort = wanted.get(shapeOf(name));
    if (cohort) cohort.members.push(name);
  }
  const marked = [];
  for (const cohort of wanted.values()) {
    if (!cohort.members.length) continue;
    store.addSource(cohort.members, SRC.COHORT);
    const random = cohort.members.filter((name) => looksRandom(name.slice(0, name.indexOf('.'))));
    store.saveCohort({
      shape: cohort.shape,
      size: cohort.members.length,
      lift: cohort.lift,
      sample: random.slice(0, 12),
    });
    marked.push({ ...cohort, members: cohort.members.length, sample: random.slice(0, 6) });
  }
  return marked;
};
