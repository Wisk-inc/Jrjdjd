// Radar's database: one SQLite file holding every domain name ever seen (tens of millions),
// the much smaller set of suspect sites being watched, and the history of what changed
//
// Uses the SQLite that ships inside Node (22.5+), so there is still nothing to install.
// Sized for small machines: the big table stores a name and four small numbers per row,
// its triage score is computed by SQLite itself, and only "hot" rows are indexed

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Where a name came from, as bits, so one small integer records every source
export const SRC = {
  PHISHING: 1,
  SCAM: 2,
  CRYPTO: 4,
  THREAT: 8,
  NRD: 16,
  CT: 32,
  RANKED: 64,
  TOPLIST: 128,
  URLFEED: 256,
  COHORT: 512,
  MANUAL: 1024,
  LINKED: 2048,
};

export const SRC_LABELS = {
  PHISHING: 'phishing blocklist',
  SCAM: 'scam blocklist',
  CRYPTO: 'crypto-scam blocklist',
  THREAT: 'threat-intelligence feed',
  NRD: 'newly registered',
  CT: 'new TLS certificate',
  RANKED: 'web-graph ranking',
  TOPLIST: 'traffic top list',
  URLFEED: 'live phishing URL feed',
  COHORT: 'bulk-registration batch',
  MANUAL: 'added by hand',
  LINKED: 'linked to a known scam',
};

const LISTED = SRC.PHISHING | SRC.SCAM | SRC.CRYPTO | SRC.THREAT;
const FRESH = SRC.NRD | SRC.CT;

export const sourceNames = (bits) => Object.keys(SRC).filter((key) => bits & SRC[key]);

// The name-only triage score, kept as SQL so it is always in step with the row:
// what the name looks like, plus where it was seen, minus how established it is
const SCORE_SQL = `max(0, min(100,
  ns
  + (CASE WHEN src & ${LISTED} THEN 60 ELSE 0 END)
  + (CASE WHEN src & ${SRC.URLFEED} THEN 15 ELSE 0 END)
  + (CASE WHEN src & ${SRC.COHORT | SRC.LINKED} THEN 40 ELSE 0 END)
  + (CASE WHEN src & ${FRESH} THEN 8 ELSE 0 END)
  + (CASE WHEN src & ${SRC.MANUAL} THEN 100 ELSE 0 END)
  - (CASE WHEN top BETWEEN 1 AND 100000 THEN 70 WHEN top > 100000 THEN 45 ELSE 0 END)
  - (CASE WHEN rank BETWEEN 1 AND 1000000 THEN 40 WHEN rank BETWEEN 1000001 AND 5000000 THEN 22 WHEN rank > 5000000 THEN 10 ELSE 0 END)
))`;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS domains (
  name TEXT PRIMARY KEY,
  src INTEGER NOT NULL DEFAULT 0,
  seen INTEGER NOT NULL,
  rank INTEGER NOT NULL DEFAULT 0,
  top INTEGER NOT NULL DEFAULT 0,
  ns INTEGER NOT NULL DEFAULT 0,
  score INTEGER GENERATED ALWAYS AS (${SCORE_SQL}) VIRTUAL
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS domains_hot ON domains(score) WHERE score >= 50;

CREATE TABLE IF NOT EXISTS sites (
  name TEXT PRIMARY KEY,
  state TEXT NOT NULL DEFAULT 'new',
  risk INTEGER NOT NULL DEFAULT 0,
  level TEXT NOT NULL DEFAULT 'low',
  why TEXT,
  category TEXT,
  kit TEXT,
  title TEXT,
  title_key TEXT,
  ip TEXT,
  asn INTEGER,
  network TEXT,
  country TEXT,
  ns TEXT,
  registrar TEXT,
  created TEXT,
  rank INTEGER NOT NULL DEFAULT 0,
  top INTEGER NOT NULL DEFAULT 0,
  src INTEGER NOT NULL DEFAULT 0,
  first_seen INTEGER NOT NULL,
  last_check INTEGER NOT NULL DEFAULT 0,
  next_check INTEGER NOT NULL DEFAULT 0,
  checks INTEGER NOT NULL DEFAULT 0,
  ups INTEGER NOT NULL DEFAULT 0,
  fails INTEGER NOT NULL DEFAULT 0,
  first_up INTEGER,
  last_up INTEGER,
  down_since INTEGER,
  taken_down INTEGER,
  down_reason TEXT,
  content_hash TEXT,
  struct_hash TEXT,
  changes INTEGER NOT NULL DEFAULT 0,
  detail TEXT
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS sites_due ON sites(next_check);
CREATE INDEX IF NOT EXISTS sites_risk ON sites(risk);
CREATE INDEX IF NOT EXISTS sites_title ON sites(title_key) WHERE title_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  at INTEGER NOT NULL,
  type TEXT NOT NULL,
  detail TEXT
);
CREATE INDEX IF NOT EXISTS events_name ON events(name, at);
CREATE INDEX IF NOT EXISTS events_at ON events(at);

CREATE TABLE IF NOT EXISTS indicators (
  kind TEXT NOT NULL,
  value TEXT NOT NULL,
  name TEXT NOT NULL,
  PRIMARY KEY (kind, value, name)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS indicators_name ON indicators(name);

CREATE TABLE IF NOT EXISTS samples (name TEXT PRIMARY KEY, url TEXT NOT NULL) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS shapes (
  shape TEXT PRIMARY KEY,
  base INTEGER NOT NULL DEFAULT 0,
  fresh INTEGER NOT NULL DEFAULT 0,
  random INTEGER NOT NULL DEFAULT 0
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS cohorts (
  shape TEXT PRIMARY KEY,
  size INTEGER NOT NULL,
  lift REAL NOT NULL,
  found INTEGER NOT NULL,
  confirmed INTEGER NOT NULL DEFAULT 0,
  sample TEXT
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT) WITHOUT ROWID;
`;

const SITE_COLUMNS = [
  'name',
  'state',
  'risk',
  'level',
  'why',
  'category',
  'kit',
  'title',
  'title_key',
  'ip',
  'asn',
  'network',
  'country',
  'ns',
  'registrar',
  'created',
  'rank',
  'top',
  'src',
  'first_seen',
  'last_check',
  'next_check',
  'checks',
  'ups',
  'fails',
  'first_up',
  'last_up',
  'down_since',
  'taken_down',
  'down_reason',
  'content_hash',
  'struct_hash',
  'changes',
  'detail',
];

export const defaultDbPath = () =>
  process.env.SCAM_FINDER_DB || path.join(os.homedir(), '.scam-finder', 'radar.db');

// Node flags its built-in SQLite as experimental on every start; that one line isn't useful
const loadSqlite = async () => {
  const emit = process.emitWarning;
  process.emitWarning = (warning, ...rest) => {
    if (String(warning?.message || warning).includes('SQLite')) return;
    emit.call(process, warning, ...rest);
  };
  try {
    return await import('node:sqlite');
  } catch {
    throw new Error(
      `Radar needs the SQLite built into Node 22.5 or newer (this is ${process.version})`,
    );
  } finally {
    process.emitWarning = emit;
  }
};

const now = () => Math.floor(Date.now() / 1000);

export class RadarStore {
  constructor(db, file) {
    this.db = db;
    this.file = file;
    this.statements = new Map();
  }

  // Open (or create) the database. cacheMb caps how much memory SQLite may use for pages
  static async open(file = defaultDbPath(), { cacheMb } = {}) {
    const { DatabaseSync } = await loadSqlite();
    if (file !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
    const db = new DatabaseSync(file);
    const cache = Number(cacheMb || process.env.SCAM_FINDER_DB_CACHE_MB || 64);
    db.exec(
      `PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA temp_store = MEMORY; PRAGMA cache_size = -${Math.round(cache * 1024)};`,
    );
    db.exec(SCHEMA);
    return new RadarStore(db, file);
  }

  close() {
    this.statements.clear();
    this.db.close();
  }

  prepare(sql) {
    let statement = this.statements.get(sql);
    if (!statement) {
      statement = this.db.prepare(sql);
      this.statements.set(sql, statement);
    }
    return statement;
  }

  // Run many writes as one transaction, which is what makes bulk loading fast
  transaction(work) {
    this.db.exec('BEGIN');
    try {
      const result = work();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  // Trade crash-safety for speed while loading millions of rows that can simply be re-fetched
  bulkMode(on) {
    this.db.exec(`PRAGMA synchronous = ${on ? 'OFF' : 'NORMAL'}`);
  }

  getMeta(key, fallback = null) {
    const row = this.prepare('SELECT value FROM meta WHERE key = ?').get(key);
    return row ? JSON.parse(row.value) : fallback;
  }

  setMeta(key, value) {
    this.prepare(
      'INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    ).run(key, JSON.stringify(value));
  }

  // Add names, or merge new facts into rows already there. Rows: { name, src, rank?, top?, ns?, seen? }
  upsertDomains(rows) {
    const statement = this.prepare(`
      INSERT INTO domains(name, src, seen, rank, top, ns) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(name) DO UPDATE SET
        src = src | excluded.src,
        rank = CASE WHEN excluded.rank > 0 AND (rank = 0 OR excluded.rank < rank) THEN excluded.rank ELSE rank END,
        top = CASE WHEN excluded.top > 0 AND (top = 0 OR excluded.top < top) THEN excluded.top ELSE top END,
        ns = max(ns, excluded.ns),
        seen = min(seen, excluded.seen)`);
    const stamp = now();
    return this.transaction(() => {
      let count = 0;
      for (const row of rows) {
        statement.run(
          row.name,
          row.src,
          row.seen || stamp,
          row.rank || 0,
          row.top || 0,
          row.ns || 0,
        );
        count += 1;
      }
      return count;
    });
  }

  addSource(names, bit) {
    const statement = this.prepare('UPDATE domains SET src = src | ? WHERE name = ?');
    return this.transaction(() => {
      for (const name of names) statement.run(bit, name);
    });
  }

  getDomain(name) {
    return (
      this.prepare('SELECT name, src, seen, rank, top, ns, score FROM domains WHERE name = ?').get(
        name,
      ) || null
    );
  }

  saveSamples(pairs) {
    const statement = this.prepare(
      'INSERT INTO samples(name, url) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET url = excluded.url',
    );
    this.transaction(() => {
      for (const [name, url] of pairs) statement.run(name, url);
    });
  }

  sampleFor(name) {
    return this.prepare('SELECT url FROM samples WHERE name = ?').get(name)?.url || null;
  }

  // Names worth visiting that aren't on the watchlist yet: freshest evidence first
  candidates(limit, minScore = 55) {
    return this.prepare(
      `
      SELECT d.name, d.src, d.seen, d.rank, d.top, d.ns, d.score
      FROM domains d
      WHERE d.score >= ? AND NOT EXISTS (SELECT 1 FROM sites s WHERE s.name = d.name)
      ORDER BY (d.src & ${SRC.MANUAL | SRC.COHORT | SRC.LINKED | SRC.URLFEED}) != 0 DESC, d.score DESC, d.seen DESC
      LIMIT ?`,
    ).all(minScore, limit);
  }

  addSites(rows) {
    const statement = this.prepare(`
      INSERT OR IGNORE INTO sites(name, why, src, rank, top, first_seen, next_check)
      VALUES (?, ?, ?, ?, ?, ?, ?)`);
    const stamp = now();
    return this.transaction(() => {
      let added = 0;
      for (const row of rows) {
        added += Number(
          statement.run(
            row.name,
            row.why || null,
            row.src || 0,
            row.rank || 0,
            row.top || 0,
            row.seen || stamp,
            stamp,
          ).changes,
        );
      }
      return added;
    });
  }

  dueSites(limit, at = now()) {
    return this.prepare('SELECT * FROM sites WHERE next_check <= ? ORDER BY next_check LIMIT ?')
      .all(at, limit)
      .map(readSite);
  }

  getSite(name) {
    const row = this.prepare('SELECT * FROM sites WHERE name = ?').get(name);
    return row ? readSite(row) : null;
  }

  saveSite(site) {
    const values = SITE_COLUMNS.map((column) => {
      const value = column === 'detail' ? JSON.stringify(site.detail || {}) : site[column];
      return value === undefined ? null : value;
    });
    this.prepare(
      `INSERT OR REPLACE INTO sites(${SITE_COLUMNS.join(', ')}) VALUES (${SITE_COLUMNS.map(() => '?').join(', ')})`,
    ).run(...values);
  }

  // Watched sites, filtered and ordered for display
  listSites({ limit = 50, minRisk = 0, state, query, since, order = 'risk', offset = 0 } = {}) {
    const where = ['risk >= ?'];
    const params = [minRisk];
    if (state) {
      where.push('state = ?');
      params.push(state);
    }
    if (since) {
      where.push('first_seen >= ?');
      params.push(since);
    }
    if (query) {
      where.push('(name LIKE ? OR title LIKE ? OR kit LIKE ? OR country = ?)');
      const like = `%${String(query).replace(/[%_]/g, '')}%`;
      params.push(like, like, like, String(query).toUpperCase());
    }
    const orders = {
      risk: 'risk DESC, last_check DESC',
      recent: 'first_seen DESC',
      checked: 'last_check DESC',
      down: 'taken_down DESC',
    };
    return this.prepare(
      `SELECT * FROM sites WHERE ${where.join(' AND ')} ORDER BY ${orders[order] || orders.risk} LIMIT ? OFFSET ?`,
    )
      .all(...params, limit, offset)
      .map(readSite);
  }

  addEvent(name, type, detail, at = now()) {
    this.prepare('INSERT INTO events(name, at, type, detail) VALUES (?, ?, ?, ?)').run(
      name,
      at,
      type,
      detail === undefined ? null : JSON.stringify(detail),
    );
  }

  eventsFor(name, limit = 100) {
    return this.prepare(
      'SELECT at, type, detail FROM events WHERE name = ? ORDER BY at DESC, id DESC LIMIT ?',
    )
      .all(name, limit)
      .map(readEvent);
  }

  recentEvents({ limit = 100, since = 0, types } = {}) {
    const filter = types?.length ? `AND type IN (${types.map(() => '?').join(', ')})` : '';
    return this.prepare(
      `SELECT name, at, type, detail FROM events WHERE at >= ? ${filter} ORDER BY at DESC, id DESC LIMIT ?`,
    )
      .all(since, ...(types || []), limit)
      .map(readEvent);
  }

  // Replace the contact points, trackers and wallets recorded for one site
  setIndicators(name, list) {
    const insert = this.prepare(
      'INSERT OR IGNORE INTO indicators(kind, value, name) VALUES (?, ?, ?)',
    );
    this.transaction(() => {
      this.prepare('DELETE FROM indicators WHERE name = ?').run(name);
      for (const item of list) insert.run(item.kind, String(item.value), name);
    });
  }

  // Other watched sites that publish the same indicator as this one
  sharedIndicators(name) {
    return this.prepare(
      `
      SELECT a.kind, a.value, b.name AS other
      FROM indicators a JOIN indicators b ON a.kind = b.kind AND a.value = b.value AND b.name != a.name
      WHERE a.name = ? LIMIT 500`,
    ).all(name);
  }

  indicatorSites(kind, value) {
    return this.prepare('SELECT name FROM indicators WHERE kind = ? AND value = ? LIMIT 500')
      .all(kind, String(value))
      .map((row) => row.name);
  }

  searchIndicators(text, limit = 100) {
    return this.prepare(
      'SELECT kind, value, count(*) AS sites FROM indicators WHERE value LIKE ? GROUP BY kind, value ORDER BY sites DESC LIMIT ?',
    ).all(`%${String(text).replace(/[%_]/g, '')}%`, limit);
  }

  // Add to the running tally of name shapes: `base` from established names, the rest from new ones
  bumpShapes(counts) {
    const statement = this.prepare(`
      INSERT INTO shapes(shape, base, fresh, random) VALUES (?, ?, ?, ?)
      ON CONFLICT(shape) DO UPDATE SET base = base + excluded.base, fresh = fresh + excluded.fresh, random = random + excluded.random`);
    this.transaction(() => {
      for (const [shape, tally] of counts)
        statement.run(shape, tally.base || 0, tally.fresh || 0, tally.random || 0);
    });
  }

  shapes(minRandom = 10) {
    return this.prepare(
      'SELECT shape, base, fresh, random FROM shapes WHERE random >= ? ORDER BY random DESC',
    ).all(minRandom);
  }

  saveCohort(cohort) {
    this.prepare(
      `
      INSERT INTO cohorts(shape, size, lift, found, confirmed, sample) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(shape) DO UPDATE SET size = excluded.size, lift = excluded.lift, sample = excluded.sample, confirmed = max(confirmed, excluded.confirmed)`,
    ).run(
      cohort.shape,
      cohort.size,
      cohort.lift,
      cohort.found || now(),
      cohort.confirmed || 0,
      JSON.stringify(cohort.sample || []),
    );
  }

  cohorts() {
    return this.prepare('SELECT * FROM cohorts ORDER BY size DESC')
      .all()
      .map((row) => ({ ...row, sample: JSON.parse(row.sample || '[]') }));
  }

  // Fresh names only, for jobs that have to look at every new registration
  *freshNames() {
    for (const row of this.prepare(`SELECT name FROM domains WHERE src & ${FRESH}`).iterate())
      yield row.name;
  }

  // Head-count of everything. Counting 16 million rows takes a second or two, so it's cached
  stats({ refresh = false } = {}) {
    let totals = refresh ? null : this.getMeta('totals');
    if (!totals) {
      const row = this.prepare(
        `
        SELECT count(*) AS domains,
          sum(src & ${LISTED} != 0) AS listed, sum(src & ${SRC.NRD} != 0) AS registered, sum(src & ${SRC.CT} != 0) AS certified,
          sum(rank > 0) AS ranked, sum(top > 0) AS toplisted, sum(src & ${SRC.COHORT} != 0) AS batched
        FROM domains`,
      ).get();
      const hot = this.prepare('SELECT count(*) AS hot FROM domains WHERE score >= 50').get().hot;
      totals = { ...row, hot, countedAt: now() };
      this.setMeta('totals', totals);
    }
    const sites = this.prepare(
      `
      SELECT count(*) AS watched, sum(checks > 0) AS visited, sum(state = 'live') AS live,
        sum(taken_down IS NOT NULL) AS takenDown, sum(level = 'critical') AS critical, sum(level = 'high') AS high,
        sum(checks) AS checks, sum(kit IS NOT NULL) AS kits
      FROM sites`,
    ).get();
    const events = this.prepare('SELECT count(*) AS events FROM events').get().events;
    const size =
      this.file !== ':memory:' && fs.existsSync(this.file) ? fs.statSync(this.file).size : 0;
    return { ...totals, ...sites, events, fileBytes: size, file: this.file };
  }
}

const readSite = (row) => ({ ...row, detail: row.detail ? JSON.parse(row.detail) : {} });
const readEvent = (row) => ({ ...row, detail: row.detail ? JSON.parse(row.detail) : null });
