// Put brand look-alikes at the front of Radar's queue:
//
//   node tools/scam-radar/prioritize.mjs [--db FILE] [--limit 300] [--per-brand 12]
//
// Radar visits the highest-scoring names first, and a name on a public blocklist always outscores
// one that is merely suspicious. With over a million blocklisted names in the index, a brand-new
// site that borrows a bank's name would wait weeks for its first visit. Those are the sites
// nobody has listed yet, and the ones that say which country a scam is aimed at.
//
// So before each scan this picks newly registered or newly certified names that borrow a brand's
// name, are not the brand's own domain, and are not being watched yet, and adds them to the
// watchlist through Radar's own `watch`. It takes a few per brand, brands tied to a country first,
// newest names first, so no single brand crowds the rest out.
import fs from 'node:fs';
import { findBrands } from './scam-finder/lib/heuristics.js';
import { watch } from './scam-finder/lib/radar/daemon.js';
import { RadarStore, SRC, defaultDbPath } from './scam-finder/lib/radar/store.js';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const dbFile = flag('--db', defaultDbPath());
const limit = Math.max(1, Number(flag('--limit', 300)) || 300);
const perBrand = Math.max(1, Number(flag('--per-brand', 12)) || 12);

if (!fs.existsSync(dbFile)) {
  console.error(`No Radar database at ${dbFile}`);
  process.exit(1);
}
const store = await RadarStore.open(dbFile);
try {
  // Fresh names that score 50 or more, with the 35 points a borrowed brand name earns
  const rows = store.prepare(`
    SELECT d.name, d.seen FROM domains d
    WHERE d.score >= 50 AND d.ns >= 35 AND (d.src & ${SRC.NRD | SRC.CT}) != 0
      AND NOT EXISTS (SELECT 1 FROM sites s WHERE s.name = d.name)
    ORDER BY d.seen DESC LIMIT 400000`).all();

  const byBrand = new Map();
  for (const row of rows) {
    const brand = findBrands({ title: '', text: '', host: row.name }).find((hit) => hit.inDomain && !hit.official);
    if (!brand) continue;
    if (!byBrand.has(brand.name)) byBrand.set(brand.name, { brand, names: [] });
    const group = byBrand.get(brand.name);
    if (group.names.length < perBrand) group.names.push(row.name);
  }

  // Brands tied to a country first, then the rest; within each, the brand with the newest name first
  const groups = [...byBrand.values()].sort((a, b) => Boolean(b.brand.country) - Boolean(a.brand.country));
  let added = 0;
  const picked = [];
  const first = store.prepare('UPDATE sites SET next_check = 0 WHERE name = ? AND checks = 0');
  // The same for look-alikes an earlier run added that are still waiting for their first visit
  const waiting = store.prepare("UPDATE sites SET next_check = 0 WHERE checks = 0 AND why LIKE 'borrows the name of %'").run().changes;
  if (waiting) console.log(`${waiting} look-alikes from earlier runs moved to the front as well`);
  for (const { brand, names } of groups) {
    if (added >= limit) break;
    const take = names.slice(0, limit - added);
    const count = watch(store, take, `borrows the name of ${brand.name}`);
    // Radar visits what has been due longest first, and after a gap between scans every site it
    // already knows is overdue. A due time of zero puts these first visits ahead of those revisits.
    for (const name of take) first.run(name);
    added += count;
    if (count) picked.push(`${brand.name}${brand.country ? ` (${brand.country})` : ''} ${count}`);
  }
  console.log(`Looked at ${rows.length.toLocaleString('en')} fresh high-scoring names; ${byBrand.size} brands borrowed; ${added} sites added to the front of the queue`);
  if (picked.length) console.log(`  ${picked.slice(0, 40).join(', ')}${picked.length > 40 ? ', …' : ''}`);
} finally {
  store.close();
}
