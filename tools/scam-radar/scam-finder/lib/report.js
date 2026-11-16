// Ways to present a result: a terminal summary, Markdown, a compact JSON digest for agents,
// and a single-file interactive map. Indicators are defanged everywhere except raw JSON

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defang, truncate } from './util.js';

const regionNames = new Intl.DisplayNames(['en'], { type: 'region' });

export const countryName = (code) => {
  try {
    return regionNames.of(code) || code;
  } catch {
    return code;
  }
};

const day = (value) => (value ? String(value).slice(0, 10) : '—');
const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;
const LEVEL_WORDS = { critical: 'CRITICAL', high: 'HIGH', medium: 'MEDIUM', low: 'LOW' };

const hostingOf = (domain) => {
  const first = domain.network?.[0];
  if (!first) return null;
  return first.shared || first.asnName || (first.asn ? `AS${first.asn}` : null);
};

const describeSources = (result) => {
  const parts = [];
  const { sources } = result;
  if (sources.urlscanWindowDays) {
    parts.push(
      `urlscan.io (last ${sources.urlscanWindowDays} days${sources.urlscanKey ? '' : ', no API key'})`,
    );
  } else {
    parts.push('urlscan.io');
  }
  parts.push('DNS over HTTPS', 'RDAP registration data', 'Certificate Transparency');
  if (sources.feeds) {
    const feeds = Object.keys(sources.feeds.loaded).length;
    const hosts = Object.values(sources.feeds.loaded).reduce((sum, count) => sum + count, 0);
    parts.push(`${plural(feeds, 'blocklist')} (${hosts.toLocaleString('en')} entries)`);
  }
  return parts.join(', ');
};

// A digest small enough to hand straight to a language model
export const compactResult = (result, { limit = 40 } = {}) => {
  const suspects = result.domains.filter((domain) => !domain.risk.benign);
  return {
    kind: result.kind,
    seed: result.seed ? { domain: result.seed.domain, url: defang(result.seed.url) } : undefined,
    hunt: result.hunt
      ? {
          profiles: result.hunt.profiles.map((profile) => profile.id),
          keywords: result.hunt.keywords,
        }
      : undefined,
    headline: result.summary.headline,
    summary: {
      domains: result.summary.domains,
      levels: result.summary.levels,
      live: result.summary.live,
      offline: result.summary.offline,
      campaigns: result.summary.campaigns,
      firstSeen: result.summary.firstSeen,
      lastSeen: result.summary.lastSeen,
      targets: result.summary.targets.map((target) => ({
        ...target,
        name: countryName(target.country),
      })),
      registrars: result.summary.registrars,
      networks: result.summary.networks,
      tlds: result.summary.tlds,
    },
    campaigns: result.campaigns.slice(0, 30).map((campaign) => ({
      id: campaign.id,
      lure: campaign.label,
      brand: campaign.brand,
      targets: campaign.targets,
      domains: campaign.size,
      live: campaign.live,
      lastSeen: day(campaign.lastSeen),
      examples: campaign.domains.slice(0, 3).map(defang),
    })),
    domains: suspects.slice(0, limit).map((domain) => ({
      domain: defang(domain.domain),
      role: domain.role,
      score: domain.risk.score,
      level: domain.risk.level,
      state: domain.state,
      title: domain.title ? truncate(domain.title, 90) : null,
      campaign: domain.campaign,
      targets: domain.targets.map((target) => target.country),
      registered: day(domain.created),
      registrar: domain.registration?.registrar || null,
      hosting: hostingOf(domain),
      lastSeen: day(domain.scans?.last),
      why: domain.risk.signals.slice(0, 4).map((signal) => signal.label),
      foundBy: [...new Set(domain.foundBy.map((found) => found.type))],
      listedOn: domain.blocklists.map((hit) => hit.name),
      evidence: domain.scans?.reports?.[0] || null,
    })),
    domainsOmitted: Math.max(0, suspects.length - limit),
    sharedInfrastructure: result.links.slice(0, 20).map((link) => ({
      kind: link.kindLabel,
      value: link.label,
      strength: link.strength,
      domains: link.domains.length,
    })),
    searches: result.pivots.map((pivot) => ({
      type: pivot.type,
      value: truncate(pivot.value, 80),
      matches: pivot.total ?? null,
      kept: pivot.kept ?? null,
      status: pivot.status,
    })),
    sources: describeSources(result),
    problems: result.sources.errors.map((error) => `${error.source}: ${error.message}`),
    partial: result.partial,
    elapsedSeconds: Math.round(result.elapsedMs / 1000),
  };
};

const pad = (text, width) => {
  const value = String(text);
  return value.length >= width ? value : value + ' '.repeat(width - value.length);
};

const seedBlock = (seed) => {
  const lines = [];
  const registration = seed.registration || {};
  lines.push(
    `${defang(seed.domain)}   risk ${seed.risk.score}/100 ${LEVEL_WORDS[seed.risk.level]}   ${seed.state}`,
  );
  if (seed.title) lines.push(`  Title: ${seed.title}`);
  const facts = [];
  if (seed.created)
    facts.push(
      `registered ${day(seed.created)}${registration.registrar ? ` via ${registration.registrar}` : ''}`,
    );
  if (seed.nameservers?.key) facts.push(`nameservers ${seed.nameservers.key}`);
  if (hostingOf(seed)) facts.push(`hosted on ${hostingOf(seed)}`);
  if (facts.length) lines.push(`  ${facts.join(' · ')}`);
  if (registration.abuseEmail) lines.push(`  Report abuse to: ${registration.abuseEmail}`);
  lines.push('  Why:');
  for (const signal of seed.risk.signals.slice(0, 10)) {
    lines.push(`    • ${signal.label}${signal.detail ? ` — ${truncate(signal.detail, 110)}` : ''}`);
  }
  return lines;
};

// Plain text for a terminal or an agent's context window
export const renderText = (result, { limit = 25 } = {}) => {
  const out = [];
  const { summary } = result;
  const suspects = result.domains.filter((domain) => !domain.risk.benign);
  const seed = suspects.find((domain) => domain.role === 'seed');
  const related = suspects.filter((domain) => domain.role !== 'seed');
  const title = result.seed
    ? `Investigation of ${defang(truncate(result.seed.url, 90))}`
    : `Hunt: ${result.hunt.profiles.map((profile) => profile.name).join(' + ') || 'custom search'}`;

  out.push(`SCAM FINDER · ${title}`, '─'.repeat(72), summary.headline, '');
  if (seed) out.push(...seedBlock(seed), '');

  if (related.length) {
    const { levels } = summary;
    out.push(
      `${result.seed ? 'Related domains' : 'Leads'}: ${related.length}   critical ${levels.critical} · high ${levels.high} · medium ${levels.medium} · low ${levels.low}   (${summary.live} confirmed live, ${summary.offline} offline)`,
    );
    if (summary.targets.length) {
      out.push(
        `Aimed at: ${summary.targets
          .slice(0, 10)
          .map((target) => `${countryName(target.country)} ${target.domains}`)
          .join(', ')}`,
      );
    }
    if (summary.firstSeen)
      out.push(`Seen in scans: ${day(summary.firstSeen)} → ${day(summary.lastSeen)}`);
    out.push('');
  }

  if (result.campaigns.length) {
    out.push(`Campaigns (${result.campaigns.length})`);
    out.push(`  ${pad('id', 5)}${pad('sites', 7)}${pad('live', 6)}${pad('last seen', 12)}lure`);
    for (const campaign of result.campaigns.slice(0, limit)) {
      const tag = [campaign.brand, campaign.targets.map(countryName).join('/')]
        .filter(Boolean)
        .join(' → ');
      out.push(
        `  ${pad(campaign.id, 5)}${pad(campaign.size, 7)}${pad(campaign.live, 6)}${pad(day(campaign.lastSeen), 12)}${truncate(campaign.label, 60)}${tag ? `  [${tag}]` : ''}`,
      );
    }
    if (result.campaigns.length > limit) out.push(`  … ${result.campaigns.length - limit} more`);
    out.push('');
  }

  if (related.length) {
    out.push(`Top ${Math.min(limit, related.length)} ${result.seed ? 'related domains' : 'leads'}`);
    out.push(
      `  ${pad('risk', 6)}${pad('level', 10)}${pad('state', 12)}${pad('domain', 34)}${pad('last seen', 12)}title`,
    );
    for (const domain of related.slice(0, limit)) {
      out.push(
        `  ${pad(domain.risk.score, 6)}${pad(domain.risk.level, 10)}${pad(domain.state, 12)}${pad(truncate(defang(domain.domain), 32), 34)}${pad(day(domain.scans?.last), 12)}${truncate(domain.title || '', 50)}`,
      );
    }
    if (related.length > limit) out.push(`  … ${related.length - limit} more in the full result`);
    out.push('');
  }

  if (result.links.length) {
    out.push('Shared infrastructure');
    for (const link of result.links.slice(0, 12)) {
      out.push(
        `  • ${link.kindLabel}: ${truncate(link.label, 60)} — ${plural(link.domains.length, 'domain')} (${link.strength} link)`,
      );
    }
    out.push('');
  }

  if (result.pivots.length) {
    out.push('Searches run');
    for (const pivot of result.pivots) {
      const outcome =
        pivot.status === 'too-common'
          ? `${pivot.total} matches, too common to mean anything, ignored`
          : pivot.status === 'skipped'
            ? 'skipped, out of time'
            : `${pivot.total ?? 0} matches, ${pivot.kept ?? 0} kept`;
      out.push(`  • ${pad(pivot.type, 9)} ${truncate(pivot.value, 56)} — ${outcome}`);
    }
    out.push('');
  }

  out.push(`Sources: ${describeSources(result)}`);
  for (const error of result.sources.errors) out.push(`Note: ${error.source} — ${error.message}`);
  if (result.partial)
    out.push(
      'Note: stopped early (time or size limit), so this is a partial picture. Raise --time or --max-domains.',
    );
  out.push(
    '',
    'Scores rank what to look at first; they are evidence-based estimates, not proof. Check before acting.',
  );
  return out.join('\n');
};

const mdCell = (text) =>
  String(text ?? '')
    .replace(/\|/g, '\\|')
    .replace(/\n/g, ' ');

// A Markdown report for tickets, notes and abuse reports
export const renderMarkdown = (result, { limit = 60 } = {}) => {
  const out = [];
  const { summary } = result;
  const suspects = result.domains.filter((domain) => !domain.risk.benign);
  const seed = suspects.find((domain) => domain.role === 'seed');
  const related = suspects.filter((domain) => domain.role !== 'seed');

  out.push(`# Scam Finder report`, '');
  out.push(
    result.seed
      ? `**Target:** \`${defang(result.seed.url)}\``
      : `**Hunt:** ${result.hunt.profiles.map((profile) => profile.name).join(', ') || 'custom search'}`,
  );
  out.push(`**Generated:** ${result.generatedAt}`, '', summary.headline, '');
  out.push(
    '> Scores are evidence-based estimates that rank what to look at first. They are not proof. Indicators are defanged (`hxxp`, `[.]`) so they cannot be clicked by accident.',
    '',
  );

  if (seed) {
    out.push(
      `## Target: \`${defang(seed.domain)}\` — ${seed.risk.score}/100 (${seed.risk.level})`,
      '',
    );
    if (seed.title) out.push(`- **Page title:** ${seed.title}`);
    if (seed.created)
      out.push(
        `- **Registered:** ${day(seed.created)}${seed.registration?.registrar ? ` via ${seed.registration.registrar}` : ''}`,
      );
    if (seed.nameservers?.key) out.push(`- **Nameservers:** ${seed.nameservers.key}`);
    if (hostingOf(seed)) out.push(`- **Hosting:** ${hostingOf(seed)}`);
    if (seed.registration?.abuseEmail)
      out.push(`- **Registrar abuse contact:** ${seed.registration.abuseEmail}`);
    out.push('', '**Why it scores this way**', '');
    for (const signal of seed.risk.signals)
      out.push(`- ${signal.label}${signal.detail ? ` — ${signal.detail}` : ''}`);
    out.push('');
  }

  if (related.length) {
    const { levels } = summary;
    out.push(`## ${result.seed ? 'Related domains' : 'Leads'} (${related.length})`, '');
    out.push(
      `Critical ${levels.critical} · High ${levels.high} · Medium ${levels.medium} · Low ${levels.low}. ${summary.live} confirmed live, ${summary.offline} offline.`,
      '',
    );
    if (summary.targets.length)
      out.push(
        `**Aimed at:** ${summary.targets.map((target) => `${countryName(target.country)} (${target.domains})`).join(', ')}`,
        '',
      );
  }

  if (result.campaigns.length) {
    out.push(
      `## Campaigns (${result.campaigns.length})`,
      '',
      '| Lure | Brand used | Aimed at | Sites | Live | Last seen |',
      '|---|---|---|---:|---:|---|',
    );
    for (const campaign of result.campaigns) {
      out.push(
        `| ${mdCell(campaign.label)} | ${mdCell(campaign.brand || '—')} | ${campaign.targets.map(countryName).join(', ') || '—'} | ${campaign.size} | ${campaign.live} | ${day(campaign.lastSeen)} |`,
      );
    }
    out.push('');
  }

  if (related.length) {
    out.push(
      `## Domains`,
      '',
      '| Risk | Domain | State | Lure | Registered | Hosting | Evidence |',
      '|---:|---|---|---|---|---|---|',
    );
    for (const domain of related.slice(0, limit)) {
      const evidence = domain.scans?.reports?.[0] ? `[scan](${domain.scans.reports[0]})` : '—';
      out.push(
        `| ${domain.risk.score} | \`${defang(domain.domain)}\` | ${domain.state} | ${mdCell(truncate(domain.title || '—', 60))} | ${day(domain.created)} | ${mdCell(hostingOf(domain) || '—')} | ${evidence} |`,
      );
    }
    if (related.length > limit)
      out.push('', `_${related.length - limit} more in the JSON result._`);
    out.push('');
  }

  if (result.links.length) {
    out.push('## Shared infrastructure', '');
    for (const link of result.links.slice(0, 25))
      out.push(
        `- **${link.kindLabel}** — ${mdCell(link.label)}: ${plural(link.domains.length, 'domain')} (${link.strength})`,
      );
    out.push('');
  }

  out.push('## How this was put together', '', `Sources: ${describeSources(result)}.`, '');
  for (const pivot of result.pivots)
    out.push(
      `- ${pivot.why || pivot.type}: \`${mdCell(truncate(pivot.value, 80))}\` → ${pivot.total ?? 0} matches, ${pivot.kept ?? 0} kept (${pivot.status})`,
    );
  if (result.sources.errors.length) {
    out.push('', '**Sources that had problems**', '');
    for (const error of result.sources.errors) out.push(`- ${error.source}: ${error.message}`);
  }
  if (result.partial)
    out.push(
      '',
      '_Stopped early because a time or size limit was reached, so this is a partial picture._',
    );
  out.push('');
  return out.join('\n');
};

const viewerDir = () => path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'viewer');

// Characters that end a script block or a line, written as code points so this file stays ASCII-safe
const UNSAFE_IN_SCRIPT = new RegExp(`[<>&${String.fromCharCode(0x2028, 0x2029)}]`, 'g');

// JSON that is safe inside a <script> tag, whatever a scam page put in its title
const embedJson = (value) =>
  JSON.stringify(value).replace(
    UNSAFE_IN_SCRIPT,
    (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );

// Drop fields the map never shows, to keep the file small
const slimForViewer = (result) => ({
  ...result,
  graph: undefined,
  domains: result.domains
    .filter((domain) => !domain.risk.benign)
    .map(({ lexical, dns, certificates, page, hosts, ...domain }) => {
      void lexical;
      return {
        ...domain,
        hosts: hosts.slice(0, 4),
        addresses: dns?.a?.slice(0, 3) || [],
        certificateHosts: certificates?.hosts?.length || 0,
        page: page
          ? {
              status: page.status,
              finalUrl: page.finalUrl,
              description: page.description,
              spoofedHost: page.og?.spoofedHost || null,
              trackers: page.trackers,
              contacts: page.contacts,
              externalHosts: (page.externalHosts || []).slice(0, 8),
              stages: (page.stages || []).map((stage) => ({
                url: stage.url,
                status: stage.status,
                title: stage.title,
              })),
            }
          : null,
      };
    }),
});

// The interactive map as one self-contained file: no network requests, safe to pass around
// `fragment` leaves off the document wrapper, for hosts that supply their own
// With no result it renders the empty page, which shows a lookup form and asks the API
export const renderHtml = (result, { fragment = false, title, dir = viewerDir() } = {}) => {
  const template = fs.readFileSync(path.join(dir, 'template.html'), 'utf8');
  const css = fs.readFileSync(path.join(dir, 'viewer.css'), 'utf8');
  const js = fs.readFileSync(path.join(dir, 'viewer.js'), 'utf8');
  const data = result ? embedJson(slimForViewer(result)) : 'null';
  let html = template
    .replace('/*__CSS__*/', () => css)
    .replace('/*__JS__*/', () => js.replace(/<\/script/gi, '<\\/script'))
    .replace(
      /(<script type="application\/json" id="scam-data">)[\s\S]*?(<\/script>)/,
      (whole, open, close) => `${open}${data}${close}`,
    );
  // A page title of the caller's choosing, for when several maps sit side by side
  if (title) {
    const safe = String(title).replace(/[<>&]/g, '');
    html = html.replace('<title>Scam Map</title>', () => `<title>${safe}</title>`);
  }
  if (fragment) {
    const head = html.slice(
      html.indexOf('<!--fragment:start-->') + 21,
      html.indexOf('<!--fragment:head-end-->'),
    );
    const body = html.slice(
      html.indexOf('<!--fragment:body-start-->') + 26,
      html.indexOf('<!--fragment:end-->'),
    );
    html = `${head.trim()}\n${body.trim()}\n`;
  } else {
    html = html.replace(/<!--fragment:[a-z-]+-->\n?/g, '');
  }
  return html;
};
