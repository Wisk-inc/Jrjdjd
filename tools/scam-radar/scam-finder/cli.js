#!/usr/bin/env node
// Command line for the scam finder. Needs nothing but Node 20+:
//
//   node scam-finder/cli.js investigate https://suspicious.example/abc --html map.html
//   node scam-finder/cli.js hunt jamaica lottery --json
//
// Progress goes to stderr and results to stdout, so output can be piped or parsed

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FEEDS, FEED_PRESETS, PROFILES, hunt, investigate } from './lib/index.js';
import { RADAR_HELP, radarCommand } from './lib/radar/commands.js';
import { RadarStore, defaultDbPath } from './lib/radar/store.js';
import { compactResult, renderHtml, renderMarkdown, renderText } from './lib/report.js';

const HELP = `Scam Finder: map the sites and infrastructure behind a scam link.

Usage
  node scam-finder/cli.js investigate <url-or-domain> [options]
  node scam-finder/cli.js hunt <profile ...> [--query Q] [--keyword K] [options]
  node scam-finder/cli.js report <result.json> [--html FILE] [--md FILE]
  node scam-finder/cli.js radar <command>      (continuous scanner: "radar help")
  node scam-finder/cli.js profiles | feeds | build-viewer | help

Commands
  investigate   Profile a suspect link, then find sites that share its fingerprints
  hunt          Collect fresh leads from saved profiles, raw urlscan queries or keywords
  report        Re-render a saved JSON result as an interactive map or Markdown
  radar         Scan continuously into a database of 16M+ domains, and query it
  profiles      List the hunt profiles
  feeds         List the blocklist feeds
  build-viewer  Regenerate public/scam-finder/index.html after editing scam-finder/viewer/

How far to look
  --depth 0|1|2     0 profile the target only, 1 find linked sites (default),
                    2 search again from every campaign found
  --quick           Small limits, done in about 30 seconds
  --deep            Depth 2, visit every site found, generous limits (several minutes)
  --max-domains N   Stop collecting after N domains (default 400)
  --pages N|all     Sites to visit live to confirm what they serve (default 15)
  --rdap N|all      Registration lookups to make (default 25)
  --feeds NAME      none | light | default | all, or a comma list of feed ids
  --time SECONDS    Give up gracefully after this long (default 240)
  --ua NAME         mobile (default) | desktop | a full user-agent string

Output
  (default)         A readable summary
  --json            The complete result as JSON
  --compact         A short JSON digest, sized for a language model
  --out FILE        Also save the complete JSON result
  --html FILE       Also save the interactive map (one self-contained file)
  --md FILE         Also save a Markdown report
  --fragment        With --html, omit the <html> wrapper
  --title TEXT      With --html, the page title (default "Scam Map")
  --quiet           No progress messages
  --no-cache        Ignore and don't write the on-disk cache

Environment
  URLSCAN_API_KEY          Searches further back than 30 days, with higher limits
  CERTSPOTTER_TOKEN        Higher Certificate Transparency limits
  SCAM_FINDER_CACHE_DIR    Where to keep cached lookups (default: the system temp dir)
  NODE_USE_ENV_PROXY=1     Make Node honour HTTPS_PROXY, if you are behind a proxy

Scores are evidence-based estimates for triage, not proof that a site is a scam.`;

const FLAGS_WITH_VALUES = new Set([
  'depth',
  'max-domains',
  'pages',
  'rdap',
  'feeds',
  'time',
  'ua',
  'out',
  'html',
  'md',
  'query',
  'keyword',
  'limit',
  'db',
  'state',
  'min-risk',
  'order',
  'types',
  'shape',
  'checks',
  'promote',
  'ct-tiles',
  'seconds',
  'ticks',
  'title',
]);
const BOOLEAN_FLAGS = new Set([
  'quick',
  'deep',
  'json',
  'compact',
  'fragment',
  'quiet',
  'no-cache',
  'help',
  'refresh',
  'no-ct',
  'online',
]);

class UsageError extends Error {}

// Split argv into positional words and flags, accepting --flag value and --flag=value
export const parseArgs = (argv) => {
  const positional = [];
  const flags = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '-h') {
      flags.help = true;
    } else if (arg.startsWith('--')) {
      const [name, inline] = arg.slice(2).split(/=(.*)/s);
      if (BOOLEAN_FLAGS.has(name)) {
        flags[name] = true;
      } else if (FLAGS_WITH_VALUES.has(name)) {
        const value = inline ?? argv[(index += 1)];
        if (value === undefined) throw new UsageError(`--${name} needs a value`);
        if (name === 'query' || name === 'keyword') (flags[name] ||= []).push(value);
        else flags[name] = value;
      } else {
        throw new UsageError(`Unknown option --${name}`);
      }
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags };
};

// Translate CLI flags into engine options
export const toOptions = (flags) => {
  const options = {
    depth: flags.depth,
    quick: Boolean(flags.quick),
    maxDomains: flags['max-domains'],
    pages: flags.pages,
    rdap: flags.rdap,
    feeds: flags.feeds,
    userAgent: flags.ua,
    timeBudgetMs: flags.time ? Number(flags.time) * 1000 : undefined,
    cacheDir: flags['no-cache'] ? false : undefined,
  };
  if (flags.deep) {
    options.depth ??= 2;
    options.pages ??= 'all';
    options.rdap ??= 80;
    options.maxDomains ??= 1000;
    options.maxResultsPerPivot = 1000;
    options.maxPivots = 30;
    options.timeBudgetMs ??= 900000;
  }
  return options;
};

const progressPrinter = (quiet) => {
  if (quiet) return undefined;
  return ({ stage, message, elapsedMs }) => {
    process.stderr.write(
      `[${String(Math.round(elapsedMs / 1000)).padStart(3)}s] ${stage}: ${message}\n`,
    );
  };
};

const writeFile = (file, text) => {
  const target = path.resolve(file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, text);
  return target;
};

// Write whichever extra files were asked for, then print the chosen view of the result
const deliver = (result, flags) => {
  const written = [];
  if (flags.out)
    written.push(['Full result', writeFile(flags.out, JSON.stringify(result, null, 1))]);
  if (flags.html)
    written.push([
      'Interactive map',
      writeFile(
        flags.html,
        renderHtml(result, { fragment: Boolean(flags.fragment), title: flags.title }),
      ),
    ]);
  if (flags.md) written.push(['Markdown report', writeFile(flags.md, renderMarkdown(result))]);

  const limit = flags.limit ? Number(flags.limit) : undefined;
  if (flags.json) {
    process.stdout.write(`${JSON.stringify(result, null, 1)}\n`);
  } else if (flags.compact) {
    const digest = compactResult(result, { limit: limit || 40 });
    digest.files = Object.fromEntries(written);
    process.stdout.write(`${JSON.stringify(digest, null, 1)}\n`);
  } else {
    process.stdout.write(`${renderText(result, { limit: limit || 25 })}\n`);
    for (const [label, file] of written) process.stdout.write(`${label}: ${file}\n`);
  }
};

const commands = {
  async investigate({ positional, flags }) {
    if (positional.length !== 1)
      throw new UsageError('investigate takes exactly one URL or domain');
    // With a Radar database to hand, every copy of the kit it has confirmed joins the map
    const database = flags.db || defaultDbPath();
    const radar = fs.existsSync(database) ? await RadarStore.open(database) : null;
    try {
      const result = await investigate(positional[0], {
        ...toOptions(flags),
        radar,
        onProgress: progressPrinter(flags.quiet),
      });
      deliver(result, flags);
    } finally {
      radar?.close();
    }
  },

  async hunt({ positional, flags }) {
    if (!positional.length && !flags.query && !flags.keyword) {
      throw new UsageError(
        `hunt needs a profile, --query or --keyword. Profiles: ${Object.keys(PROFILES).join(', ')}`,
      );
    }
    const result = await hunt(
      { profiles: positional, queries: flags.query, keywords: flags.keyword },
      { ...toOptions(flags), onProgress: progressPrinter(flags.quiet) },
    );
    deliver(result, flags);
  },

  async report({ positional, flags }) {
    if (positional.length !== 1)
      throw new UsageError('report takes the path of a saved JSON result');
    const result = JSON.parse(fs.readFileSync(positional[0], 'utf8'));
    if (result.tool !== 'scam-finder')
      throw new UsageError(`${positional[0]} is not a scam-finder result`);
    deliver(result, flags);
  },

  // The continuous scanner and its database (see `radar help`)
  async radar(parsed) {
    await radarCommand(parsed);
  },

  async profiles() {
    for (const [id, profile] of Object.entries(PROFILES)) {
      process.stdout.write(`${id}\n  ${profile.name}: ${profile.description}\n`);
      for (const query of profile.queries) process.stdout.write(`    - ${query.why}\n`);
    }
  },

  // Rebuild the hosted page (public/scam-finder/index.html) from the viewer sources
  async 'build-viewer'({ flags }) {
    const target =
      flags.out || fileURLToPath(new URL('../public/scam-finder/index.html', import.meta.url));
    process.stdout.write(`Wrote ${writeFile(target, renderHtml(null))}\n`);
  },

  async feeds() {
    for (const [id, feed] of Object.entries(FEEDS)) {
      process.stdout.write(
        `${id.padEnd(20)} ${feed.kind.padEnd(9)} ${feed.heavy ? 'large' : 'small'}  ${feed.name}\n`,
      );
    }
    process.stdout.write(
      `\nPresets: ${Object.entries(FEED_PRESETS)
        .map(([name, ids]) => `${name} (${ids.length})`)
        .join(', ')}\n`,
    );
  },
};

export const main = async (argv) => {
  const [command, ...rest] = argv;
  if (!command || command === 'help' || command === '--help' || command === '-h') {
    process.stdout.write(`${HELP}\n`);
    return 0;
  }
  try {
    const parsed = parseArgs(rest);
    if (parsed.flags.help) {
      process.stdout.write(`${command === 'radar' ? RADAR_HELP : HELP}\n`);
      return 0;
    }
    if (!commands[command]) throw new UsageError(`Unknown command "${command}"`);
    await commands[command](parsed);
    return 0;
  } catch (error) {
    const usage = error instanceof UsageError;
    process.stderr.write(`${usage ? 'Usage error' : 'Error'}: ${error.message}\n`);
    if (usage) process.stderr.write('Run "node scam-finder/cli.js help" for options.\n');
    return usage ? 2 : 1;
  }
};

// Run only when started directly, so tests can import the helpers above
const startedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (startedDirectly) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
