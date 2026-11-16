// Turns a flat list of scored domains into structure: campaigns, shared-infrastructure links,
// a headline summary, and a plain node-and-edge graph for anything that wants to draw it

import { usableTitle } from './heuristics.js';
import { LEVELS } from './score.js';
import { normalizeTitle, stripEmoji } from './util.js';

const countBy = (items, keyOf) => {
  const counts = new Map();
  for (const item of items) {
    for (const key of [].concat(keyOf(item) ?? [])) {
      if (key !== null && key !== undefined && key !== '')
        counts.set(key, (counts.get(key) || 0) + 1);
    }
  }
  return [...counts].sort((a, b) => b[1] - a[1]);
};

const top = (items, keyOf) => countBy(items, keyOf)[0]?.[0] ?? null;

// Which campaign a domain belongs to: its lure title if it has a telling one, else its kit
const campaignKey = (domain) => {
  if (domain.title && usableTitle(domain.title)) return `title:${normalizeTitle(domain.title)}`;
  if (domain.kits.length) return `kit:${domain.kits[0].id}`;
  const kitFile = domain.foundBy.find((found) => found.type === 'kit');
  if (kitFile) return `kitfile:${kitFile.value}`;
  return null;
};

// The name before the dash in "Brand - Some Holiday Gift!", when the title is built that way
const titleBrand = (title) => {
  const match = stripEmoji(title || '').match(/^([^-–|:]{2,30}?)\s+[-–]\s+\S/);
  return match && match[1].trim().split(/\s+/).length <= 3 ? match[1].trim() : null;
};

// Group domains that are running the same lure, and tag each domain with its campaign
export const buildCampaigns = (domains) => {
  const groups = new Map();
  for (const domain of domains) {
    if (domain.risk.benign) continue;
    const key = campaignKey(domain);
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(domain);
  }

  const campaigns = [...groups].map(([key, members]) => {
    const titles = members.map((member) => member.title).filter(Boolean);
    const rawTitle = top(titles, (title) => title);
    const kit = top(members, (member) => member.kits[0]?.name);
    const seenTimes = members
      .flatMap((member) => [member.scans?.first, member.scans?.last])
      .filter(Boolean)
      .sort();
    return {
      key,
      label: rawTitle ? stripEmoji(rawTitle) : kit || 'Same kit, no title captured',
      title: rawTitle,
      brand:
        top(members, (member) =>
          member.brands
            .filter((brand) => !brand.official && (brand.inTitle || brand.inDomain))
            .map((brand) => brand.name),
        ) || titleBrand(rawTitle),
      targets: countBy(members, (member) => member.targets.map((target) => target.country))
        .map(([country]) => country)
        .slice(0, 3),
      lure: top(members, (member) => member.lures[0]?.id),
      kit,
      domains: members.map((member) => member.domain),
      size: members.length,
      live: members.filter((member) => member.state === 'live').length,
      maxScore: Math.max(...members.map((member) => member.risk.score)),
      firstSeen: seenTimes[0] || null,
      lastSeen: seenTimes[seenTimes.length - 1] || null,
      hasSeed: members.some((member) => member.role === 'seed'),
    };
  });

  campaigns.sort((a, b) => b.hasSeed - a.hasSeed || b.size - a.size || b.maxScore - a.maxScore);
  campaigns.forEach((campaign, index) => {
    campaign.id = `c${index + 1}`;
  });
  const byDomain = new Map(
    campaigns.flatMap((campaign) => campaign.domains.map((name) => [name, campaign.id])),
  );
  for (const domain of domains) domain.campaign = byDomain.get(domain.domain) || null;
  return campaigns;
};

// The kinds of thing two domains can have in common, and how much each one means
const LINK_KINDS = {
  kit: { label: 'Same scam kit', strength: 'strong' },
  file: { label: 'Same kit file', strength: 'strong' },
  hash: { label: 'Byte-identical file', strength: 'strong' },
  tracker: { label: 'Same tracking ID', strength: 'strong' },
  contact: { label: 'Same contact or wallet', strength: 'strong' },
  certificate: { label: 'Shared TLS certificate', strength: 'strong' },
  structure: { label: 'Same page skeleton', strength: 'strong' },
  server: { label: 'Same dedicated server', strength: 'medium' },
  redirect: { label: 'Same redirect chain', strength: 'medium' },
  registered: { label: 'Registered the same day', strength: 'medium' },
  nameservers: { label: 'Same Cloudflare nameserver pair', strength: 'weak' },
  naming: { label: 'Same naming pattern', strength: 'weak' },
};

// Every attribute shared by two or more domains, as { kind, key, domains }
export const buildLinks = (domains) => {
  const buckets = new Map();
  const put = (kind, key, domain, label) => {
    if (!key) return;
    const id = `${kind}:${key}`;
    if (!buckets.has(id))
      buckets.set(id, {
        id,
        kind,
        key: String(key),
        label: label || String(key),
        domains: new Set(),
      });
    buckets.get(id).domains.add(domain.domain);
  };

  for (const domain of domains) {
    if (domain.risk.benign) continue;
    for (const kit of domain.kits) put('kit', kit.id, domain, kit.name);
    for (const found of domain.foundBy) {
      if (found.type === 'kit' || found.type === 'filename') put('file', found.value, domain);
      if (found.type === 'hash')
        put('hash', found.value, domain, `sha256 ${String(found.value).slice(0, 12)}…`);
      if (found.type === 'certificate')
        put('certificate', found.value, domain, `Certificate shared with ${found.value}`);
      if (found.type === 'redirect')
        put('redirect', found.value, domain, `Redirect chain through ${found.value}`);
    }
    // A seed is in every group it started, so the group shows what it links to
    if (domain.role === 'seed') {
      for (const resource of domain.page?.resources || [])
        put('file', resource.path.replace(/^\//, ''), domain);
      for (const item of domain.resourceHashes || [])
        put('hash', item.sha256, domain, `sha256 ${item.sha256.slice(0, 12)}…`);
      if (domain.certificates?.siblings?.length)
        put('certificate', domain.domain, domain, `Certificate shared with ${domain.domain}`);
      put('redirect', domain.domain, domain, `Redirect chain through ${domain.domain}`);
    }
    for (const tracker of domain.page?.trackers || [])
      put('tracker', `${tracker.kind}:${tracker.id}`, domain, `${tracker.kind} ${tracker.id}`);
    for (const contact of domain.page?.contacts || [])
      put('contact', `${contact.kind}:${contact.id}`, domain, `${contact.kind} ${contact.id}`);
    for (const address of domain.network) {
      if (address.ip && address.asn && !address.shared)
        put(
          'server',
          address.ip,
          domain,
          `${address.ip} (${address.asnName || `AS${address.asn}`})`,
        );
    }
    if (domain.structure)
      put('structure', domain.structure, domain, `Page skeleton ${domain.structure.slice(0, 8)}…`);
    if (domain.nameservers?.accountLevel) put('nameservers', domain.nameservers.key, domain);
    if (domain.batch)
      put('registered', domain.batch.date, domain, `Registered ${domain.batch.date}`);
    if (domain.cohort)
      put('naming', domain.cohort.shape, domain, describeShape(domain.cohort.shape));
  }

  return [...buckets.values()]
    .filter((bucket) => bucket.domains.size >= 2)
    .map((bucket) => ({
      id: bucket.id,
      kind: bucket.kind,
      kindLabel: LINK_KINDS[bucket.kind].label,
      strength: LINK_KINDS[bucket.kind].strength,
      key: bucket.key,
      label: bucket.label,
      domains: [...bucket.domains].sort(),
    }))
    .sort((a, b) => b.domains.length - a.domains.length);
};

// "letters5.buzz" as a phrase a person would say
export const describeShape = (shape) => {
  const match = shape.match(/^([a-z]+)(\d+)\.(.+)$/);
  if (!match) return shape;
  const kinds = {
    letters: 'letters',
    digits: 'digits',
    alnum: 'letters and digits',
    hyphenated: 'characters with hyphens',
    mixed: 'characters',
  };
  return `${match[2]} random ${kinds[match[1]] || 'characters'} + .${match[3]}`;
};

// The figures a reader wants first, plus one sentence that says what was found
export const summarize = (result) => {
  const suspects = result.domains.filter((domain) => !domain.risk.benign);
  const related = suspects.filter((domain) => domain.role !== 'seed');
  const levels = Object.fromEntries(LEVELS.map((level) => [level.id, 0]));
  for (const domain of suspects) levels[domain.risk.level] += 1;
  const seed = result.domains.find((domain) => domain.role === 'seed') || null;
  const times = suspects
    .flatMap((domain) => [domain.scans?.first, domain.scans?.last])
    .filter(Boolean)
    .sort();
  const targets = countBy(suspects, (domain) => domain.targets.map((target) => target.country))
    .slice(0, 12)
    .map(([country, count]) => ({ country, domains: count }));
  const registrars = countBy(suspects, (domain) => domain.registration?.registrar)
    .slice(0, 5)
    .map(([registrar, count]) => ({ registrar, domains: count }));
  const networks = countBy(
    suspects,
    (domain) => domain.network[0]?.shared || domain.network[0]?.asnName,
  )
    .slice(0, 5)
    .map(([network, count]) => ({ network, domains: count }));
  const tlds = countBy(suspects, (domain) => domain.domain.split('.').pop())
    .slice(0, 6)
    .map(([tld, count]) => ({ tld, domains: count }));
  const serious = levels.critical + levels.high;

  let headline;
  if (seed) {
    const verdict = {
      critical: 'almost certainly a scam',
      high: 'very likely a scam',
      medium: 'suspicious',
      low: 'not showing strong scam signals',
    }[seed.risk.level];
    const kit = seed.kits[0]?.name;
    headline = `${seed.domain} is ${verdict}${kit ? ` (${kit})` : ''}.`;
    if (related.length) {
      headline += ` It is linked to ${related.length} other domain${related.length === 1 ? '' : 's'} across ${result.campaigns.length} campaign${result.campaigns.length === 1 ? '' : 's'}; ${serious} of all ${suspects.length} rate high or critical.`;
    } else if (result.options.depth > 0) {
      headline += ' No related domains turned up in the sources searched.';
    }
  } else {
    headline = `${suspects.length} lead${suspects.length === 1 ? '' : 's'} collected; ${serious} rate high or critical on their own evidence.`;
  }

  return {
    headline,
    domains: suspects.length,
    related: related.length,
    levels,
    live: suspects.filter((domain) => domain.state === 'live').length,
    offline: suspects.filter((domain) => domain.state === 'offline').length,
    campaigns: result.campaigns.length,
    firstSeen: times[0] || null,
    lastSeen: times[times.length - 1] || null,
    targets,
    registrars,
    networks,
    tlds,
    seedScore: seed ? seed.risk.score : null,
    seedLevel: seed ? seed.risk.level : null,
  };
};

// A generic graph: domains, the campaigns they run and the attributes they share
export const toGraph = (result) => {
  const nodes = [];
  const edges = [];
  const rootId = result.seed ? `domain:${result.seed.domain}` : 'hunt';
  if (!result.seed) {
    nodes.push({
      id: 'hunt',
      type: 'hunt',
      label: (result.hunt?.profiles || []).map((profile) => profile.name).join(' + ') || 'Hunt',
    });
  }
  for (const domain of result.domains) {
    if (domain.risk.benign) continue;
    nodes.push({
      id: `domain:${domain.domain}`,
      type: domain.role === 'seed' ? 'seed' : 'domain',
      label: domain.domain,
      score: domain.risk.score,
      level: domain.risk.level,
      state: domain.state,
    });
    if (domain.campaign)
      edges.push({
        source: `domain:${domain.domain}`,
        target: `campaign:${domain.campaign}`,
        type: 'runs',
      });
    else if (`domain:${domain.domain}` !== rootId)
      edges.push({
        source: rootId,
        target: `domain:${domain.domain}`,
        type: domain.foundBy[0]?.type || 'related',
      });
  }
  for (const campaign of result.campaigns) {
    nodes.push({
      id: `campaign:${campaign.id}`,
      type: 'campaign',
      label: campaign.label,
      size: campaign.size,
    });
    if (!campaign.hasSeed)
      edges.push({ source: rootId, target: `campaign:${campaign.id}`, type: 'linked' });
  }
  for (const link of result.links) {
    nodes.push({
      id: `link:${link.id}`,
      type: 'link',
      kind: link.kind,
      label: link.label,
      strength: link.strength,
      size: link.domains.length,
    });
    for (const name of link.domains)
      edges.push({ source: `domain:${name}`, target: `link:${link.id}`, type: link.kind });
  }
  return { root: rootId, nodes, edges };
};
