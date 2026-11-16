// The `radar` commands of the CLI: build the index, run the scanner, and ask it questions

import fs from 'node:fs';
import path from 'node:path';
import { describeContact } from '../contacts.js';
import { NetContext } from '../net.js';
import { renderHtml } from '../report.js';
import { defang, loadPsl, parseTarget, refang } from '../util.js';
import { detectCohorts, markCohorts } from './cohorts.js';
import { TICK_DEFAULTS, promote, run, tick, watch } from './daemon.js';
import { SOURCES } from './ingest.js';
import { RadarStore, SRC } from './store.js';
import { shapeOf } from './triage.js';
import { describeEvent, overview, radarMap, siteReport } from './view.js';

export const RADAR_HELP = `Radar: a scanner that keeps running, with a database behind it.

  node scam-finder/cli.js radar <command> [options]

Build the index (run once, then let "run" keep it fresh)
  ingest all                 Everything below, in order (about 5 minutes, 750 MB)
  ingest ranked [--limit N]  Top domains of the web by link-graph rank (default 15,000,000)
  ingest toplist             The million most-visited domains (Tranco)
  ingest feeds [--feeds all] Public scam and phishing blocklists
  ingest nrd                 Domains registered in the last 30 days
  ingest ct                  Newest TLS certificates

Scan
  run [--ticks N]            Scan continuously: one cycle every --seconds (default 60)
  tick                       Run a single cycle and stop
  watch <domain ...>         Put domains on the watchlist by hand
  watch --shape NAME         Watch every new domain cast from one mould, e.g. letters5.buzz
     --checks N              Site visits per cycle (default ${TICK_DEFAULTS.checks})
     --promote N             New sites taken onto the watchlist per cycle (default ${TICK_DEFAULTS.promote})
     --ct-tiles N            Certificate-log tiles read per cycle, 256 certificates each (default ${TICK_DEFAULTS.ctTiles})
     --no-ct                 Don't read certificate logs

Ask
  status [--refresh]         Headline numbers
  sites [--state live] [--min-risk N] [--query TEXT] [--order risk|recent|down] [--limit N]
  site <domain>              Everything known about one domain, with its history
  events [--types taken-down,title] [--limit N]
  batches                    Bulk-registration moulds found among new domains
  map --html FILE            The watchlist as an interactive map
  contact <email-or-phone> [--online]   What a contact point says about itself

Every command takes --db FILE (default ~/.scam-finder/radar.db) and --json.`;

const print = (text) => process.stdout.write(`${text}\n`);
const json = (value) => print(JSON.stringify(value, null, 1));
const number = (value) => Number(value || 0).toLocaleString('en');
const day = (value) => (value ? String(value).slice(0, 16).replace('T', ' ') : '—');
const pad = (text, width) => String(text ?? '').padEnd(width);

const tickOptions = (flags) => ({
  seconds: flags.seconds ? Number(flags.seconds) : undefined,
  checks: flags.checks ? Number(flags.checks) : undefined,
  promote: flags.promote !== undefined ? Number(flags.promote) : undefined,
  ctTiles: flags['ct-tiles'] ? Number(flags['ct-tiles']) : undefined,
  ct: flags['no-ct'] ? false : undefined,
});
const clean = (options) =>
  Object.fromEntries(Object.entries(options).filter(([, value]) => value !== undefined));

const tickLine = (report) => {
  const certs = report.certificates
    ? `certificates +${number(report.certificates.newDomains)} new domains, `
    : '';
  const checks = report.checks;
  return `[${report.at.slice(11, 19)}] ${certs}watchlist +${report.promoted}, visited ${checks.checked} (${checks.live} up, ${checks.down} down), ${checks.takedowns} takedowns, ${checks.events} events, ${report.seconds}s${checks.outage ? ' — connection trouble, results discarded' : ''}`;
};

const printStatus = (view) => {
  const { indexed, watched } = view;
  print(`RADAR · ${view.database.file} (${number(view.database.megabytes)} MB)`);
  print('─'.repeat(72));
  print(`Indexed domains      ${number(indexed.domains)}`);
  print(
    `  ranked by links    ${number(indexed.ranked)}   ranked by visits ${number(indexed.trafficRanked)}`,
  );
  print(
    `  on a blocklist     ${number(indexed.blocklisted)}   newly registered ${number(indexed.newlyRegistered)}   from certificates ${number(indexed.fromCertificates)}`,
  );
  print(
    `  in bulk batches    ${number(indexed.inBulkBatches)}   worth visiting   ${number(indexed.worthVisiting)}`,
  );
  print(
    `Watched sites        ${number(watched.sites)}   visited ${number(watched.visited)}   up now ${number(watched.live)}   taken down ${number(watched.takenDown)}`,
  );
  print(
    `  critical ${number(watched.critical)} · high ${number(watched.high)} · running a known kit ${number(watched.runningAKnownKit)}`,
  );
  print(
    `  ${number(watched.checksMade)} visits made, ${number(watched.eventsLogged)} events logged, ${number(view.ticks)} scan cycles`,
  );
  if (view.byCategory.length)
    print(`By type: ${view.byCategory.map((row) => `${row.key} ${number(row.sites)}`).join(', ')}`);
  if (view.batches.length) {
    print('\nBulk-registration batches (new domains cast from one mould)');
    for (const batch of view.batches.slice(0, 8))
      print(
        `  ${pad(batch.shape, 34)} ${pad(number(batch.names), 8)} ${batch.timesOverRepresented}× expected   e.g. ${batch.examples.map(defang).join(', ')}`,
      );
  }
  if (view.lastTick) print(`\nLast cycle: ${tickLine(view.lastTick)}`);
};

const printSites = (sites) => {
  print(`${pad('risk', 6)}${pad('state', 13)}${pad('up%', 6)}${pad('domain', 36)}what`);
  for (const site of sites) {
    const uptime = site.checks ? `${Math.round((100 * site.ups) / site.checks)}` : '—';
    const what = site.title || site.down_reason || site.why || '';
    print(
      `${pad(site.risk, 6)}${pad(site.state, 13)}${pad(uptime, 6)}${pad(defang(site.name).slice(0, 34), 36)}${String(what).slice(0, 70)}`,
    );
  }
};

const printSite = (report) => {
  print(
    `${defang(report.domain)}${report.watched ? `   risk ${report.risk.score}/100 ${report.risk.level.toUpperCase()}   ${report.state}` : '   (indexed, not watched)'}`,
  );
  if (report.indexed) {
    const { indexed } = report;
    print(
      `  Seen in: ${indexed.sources.join(', ') || '—'} · triage ${indexed.triageScore}${indexed.nameSignals.length ? ` (${indexed.nameSignals.join(', ')})` : ''}`,
    );
  }
  if (!report.watched) return;
  if (report.title) print(`  Title: ${report.title}`);
  if (report.category || report.kit)
    print(`  Type: ${[report.category, report.kit?.name].filter(Boolean).join(' · ')}`);
  if (report.targets.length)
    print(
      `  Aimed at: ${report.targets.map((target) => `${target.country} (${target.why})`).join(', ')}`,
    );
  const life = report.lifespan;
  print(
    `  Watched since ${day(life.firstSeen)} · ${life.checks} visits · up ${life.uptime ?? '—'}% of them · ${life.changes} changes`,
  );
  if (life.takenDown)
    print(
      `  Taken down between ${day(life.takedownWindow?.after)} and ${day(life.takedownWindow?.before)} UTC. ${life.downReason || ''}`,
    );
  else if (life.downSince)
    print(`  Down since ${day(life.downSince)} UTC. ${life.downReason || ''}`);
  print(`  Popularity: ${report.popularity}`);
  const host = report.hosting;
  print(
    `  Hosting: ${[host.ip, host.network, host.behindSharedNetwork ? 'real server location hidden behind this network' : host.country].filter(Boolean).join(' · ') || '—'}`,
  );
  if (report.registration.registrar)
    print(
      `  Registered ${day(report.registration.created).slice(0, 10)} via ${report.registration.registrar}${report.registration.abuseEmail ? ` · abuse: ${report.registration.abuseEmail}` : ''}`,
    );
  if (report.risk.signals.length) {
    print('  Why:');
    for (const signal of report.risk.signals)
      print(
        `    • ${signal.label}${signal.detail ? ` — ${String(signal.detail).slice(0, 110)}` : ''}`,
      );
  }
  if (report.code.findings.length) {
    print(
      `  What its code does${report.code.encodedLayers ? ` (read through ${report.code.encodedLayers} layer${report.code.encodedLayers > 1 ? 's' : ''} of encoding)` : ''}:`,
    );
    for (const finding of report.code.findings)
      print(
        `    • ${finding.label}${finding.hidden ? ' [hidden]' : ''} — ${finding.evidence.slice(0, 100)}`,
      );
  }
  if (report.contacts.length)
    print(
      `  Contacts on the page: ${report.contacts.map((item) => `${item.kind} ${item.id}`).join(', ')}`,
    );
  for (const group of report.sharedWith.slice(0, 6))
    print(
      `  Shares ${group.kind} ${String(group.value).slice(0, 40)} with ${group.sites.length} other site${group.sites.length === 1 ? '' : 's'}: ${group.sites.slice(0, 5).map(defang).join(', ')}`,
    );
  if (report.events.length) {
    print('  History:');
    for (const event of report.events.slice(0, 15)) print(`    ${day(event.at)}  ${event.text}`);
  }
};

const openStore = (flags) => RadarStore.open(flags.db || undefined);

const commands = {
  async status(store, { flags }) {
    const view = overview(store, { refresh: Boolean(flags.refresh) });
    if (flags.json) json(view);
    else printStatus(view);
  },

  async ingest(store, { positional, flags }) {
    const wanted =
      positional[0] === 'all' || !positional.length
        ? ['ranked', 'toplist', 'feeds', 'nrd', 'ct']
        : positional;
    const unknown = wanted.filter((name) => !SOURCES[name]);
    if (unknown.length)
      throw new Error(
        `Unknown source: ${unknown.join(', ')}. Sources: ${Object.keys(SOURCES).join(', ')}, all`,
      );
    await loadPsl();
    const ctx = new NetContext({});
    const log = flags.quiet ? () => {} : (message) => process.stderr.write(`  ${message}\n`);
    store.bulkMode(true);
    const done = [];
    for (const name of wanted) {
      const options = {
        log,
        limit: flags.limit ? Number(flags.limit) : undefined,
        feeds: flags.feeds || 'all',
        tiles: flags['ct-tiles'] ? Number(flags['ct-tiles']) : 40,
        backfill: 40,
      };
      const result = await SOURCES[name].run(store, ctx, clean(options));
      done.push({ source: name, names: result.names, seconds: Math.round(result.ms / 1000) });
    }
    store.bulkMode(false);
    const marked = markCohorts(store, detectCohorts(store));
    const view = overview(store, { refresh: true });
    if (flags.json)
      return json({
        ingested: done,
        batches: marked.length,
        indexed: view.indexed,
        problems: ctx.errors,
      });
    for (const item of done)
      print(`${pad(item.source, 9)} ${pad(number(item.names), 12)} names in ${item.seconds}s`);
    print(`Bulk-registration batches flagged: ${marked.length}`);
    print(
      `Index now holds ${number(view.indexed.domains)} domains (${number(view.database.megabytes)} MB).`,
    );
    for (const error of ctx.errors) print(`Note: ${error.source} — ${error.message}`);
    return undefined;
  },

  async tick(store, { flags }) {
    const log =
      flags.quiet || flags.json ? undefined : (message) => process.stderr.write(`  ${message}\n`);
    const report = await tick(store, clean({ ...tickOptions(flags), log }));
    if (flags.json) json(report);
    else print(tickLine(report));
  },

  async run(store, { flags }) {
    print(
      `Radar is scanning: one cycle every ${flags.seconds || TICK_DEFAULTS.seconds}s. Press Ctrl+C to stop after the current cycle.`,
    );
    await run(
      store,
      clean({
        ...tickOptions(flags),
        ticks: flags.ticks ? Number(flags.ticks) : undefined,
        onTick: (report) => print(flags.json ? JSON.stringify(report) : tickLine(report)),
      }),
    );
  },

  async watch(store, { positional, flags }) {
    await loadPsl();
    let names = positional.map((value) => parseTarget(value).domain);
    if (flags.shape) {
      names = [];
      for (const name of store.freshNames()) if (shapeOf(name) === flags.shape) names.push(name);
      store.addSource(names, SRC.COHORT);
    }
    if (!names.length)
      throw new Error('Nothing to watch: give domains, or --shape with a mould that has members');
    const added = watch(
      store,
      names,
      flags.shape ? `bulk-registration batch (${flags.shape})` : 'added by hand',
    );
    if (flags.json) json({ requested: names.length, added });
    else
      print(
        `${added} of ${names.length} added to the watchlist. They will be visited on the next cycle.`,
      );
  },

  async promote(store, { flags }) {
    const added = promote(store, { limit: flags.limit ? Number(flags.limit) : 500 });
    print(`${added} sites added to the watchlist.`);
  },

  async sites(store, { flags }) {
    const sites = store.listSites(
      clean({
        limit: flags.limit ? Number(flags.limit) : 40,
        minRisk: flags['min-risk'] ? Number(flags['min-risk']) : undefined,
        state: flags.state,
        query: flags.query?.[0],
        order: flags.order,
      }),
    );
    if (flags.json) json(sites.map((site) => ({ ...site, name: defang(site.name) })));
    else printSites(sites);
  },

  async site(store, { positional, flags }) {
    if (positional.length !== 1) throw new Error('site takes one domain');
    await loadPsl();
    const report = siteReport(store, parseTarget(positional[0]).domain);
    if (!report) throw new Error(`${positional[0]} is not in the index`);
    if (flags.json) json(report);
    else printSite(report);
  },

  async events(store, { flags }) {
    const events = store
      .recentEvents({
        limit: flags.limit ? Number(flags.limit) : 40,
        types: flags.types ? flags.types.split(',') : undefined,
      })
      .map(describeEvent);
    if (flags.json) return json(events);
    for (const event of events)
      print(`${day(event.at)}  ${pad(defang(event.domain).slice(0, 34), 36)}${event.text}`);
    return undefined;
  },

  async batches(store, { flags }) {
    const cohorts = detectCohorts(store);
    if (flags.json) return json(cohorts);
    print(
      `${pad('mould', 24)}${pad('new', 9)}${pad('random', 9)}${pad('established', 13)}over-represented`,
    );
    for (const cohort of cohorts.slice(0, flags.limit ? Number(flags.limit) : 40))
      print(
        `${pad(cohort.shape, 24)}${pad(number(cohort.size), 9)}${pad(number(cohort.random), 9)}${pad(number(cohort.established), 13)}${cohort.lift}×`,
      );
    return undefined;
  },

  async map(store, { flags }) {
    const result = radarMap(
      store,
      clean({
        limit: flags.limit ? Number(flags.limit) : undefined,
        minRisk: flags['min-risk'] ? Number(flags['min-risk']) : undefined,
        query: flags.query?.[0],
        state: flags.state,
      }),
    );
    if (flags.out) fs.writeFileSync(path.resolve(flags.out), JSON.stringify(result));
    if (flags.html)
      fs.writeFileSync(
        path.resolve(flags.html),
        renderHtml(result, { fragment: Boolean(flags.fragment), title: flags.title }),
      );
    if (flags.json) json(result);
    else
      print(
        `${result.summary.headline}\nMap of ${result.domains.length} sites${flags.html ? ` written to ${path.resolve(flags.html)}` : ' (add --html FILE to save it)'}`,
      );
  },

  async contact(store, { positional, flags }) {
    if (positional.length !== 1) throw new Error('contact takes one email address or phone number');
    const value = refang(positional[0]);
    const info = await describeContact(new NetContext({}), value, {
      online: Boolean(flags.online),
    });
    if (!info) throw new Error(`"${positional[0]}" is neither an email address nor a phone number`);
    const key = info.kind === 'email' ? info.email : info.phone;
    info.seenOn = [
      ...new Set([
        ...store.indicatorSites(info.kind, key),
        ...(info.kind === 'phone' ? store.indicatorSites('whatsapp', key) : []),
      ]),
    ];
    if (flags.json) return json(info);
    print(
      `${info.kind === 'email' ? info.email : `${info.phone}${info.countryName ? ` (${info.countryName})` : ''}`}`,
    );
    for (const note of info.notes) print(`  ${note}`);
    if (info.spamReports)
      print(
        `  Spam reports: ${info.spamReports.reported ? `${info.spamReports.reports}, last ${info.spamReports.lastSeen}` : 'none on record'}`,
      );
    if (info.breachExposure?.breaches)
      print(
        `  Breaches: ${info.breachExposure.breaches.map((breach) => `${breach.name} (${breach.date})`).join(', ') || 'none on record'}`,
      );
    else if (info.breachExposure?.skipped) print(`  Breaches: ${info.breachExposure.skipped}`);
    print(
      `  On watched scam sites: ${info.seenOn.length ? info.seenOn.map(defang).join(', ') : 'none so far'}`,
    );
    print(`  ${info.caveat}`);
    return undefined;
  },
};

export const radarCommand = async ({ positional, flags }) => {
  const [name, ...rest] = positional;
  if (!name || name === 'help' || flags.help) {
    print(RADAR_HELP);
    return;
  }
  if (!commands[name])
    throw new Error(`Unknown radar command "${name}". Try: ${Object.keys(commands).join(', ')}`);
  const store = await openStore(flags);
  try {
    await commands[name](store, { positional: rest, flags });
  } finally {
    store.close();
  }
};
