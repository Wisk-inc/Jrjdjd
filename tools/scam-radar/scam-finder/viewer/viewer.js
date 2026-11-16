// Interactive scam map. Plain browser JavaScript with no dependencies and no network
// requests of its own (apart from the lookup form on the hosted page)
//
// Everything shown comes from the JSON in #scam-data. Titles and hostnames in it were
// written by whoever runs the scam sites, so text only ever enters the page as text
(() => {
  'use strict';

  const byId = (id) => document.getElementById(id);

  // Build an element. Children that are strings become text nodes, never markup
  const h = (tag, props, ...children) => {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(props || {})) {
      if (value === null || value === undefined || value === false) continue;
      if (key === 'class') node.className = value;
      else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
      else node.setAttribute(key, value === true ? '' : value);
    }
    for (const child of children.flat()) {
      if (child === null || child === undefined || child === false) continue;
      node.append(child.nodeType ? child : document.createTextNode(String(child)));
    }
    return node;
  };

  const LEVELS = [
    { id: 'critical', label: 'Critical', shape: 'diamond' },
    { id: 'high', label: 'High', shape: 'triangle' },
    { id: 'medium', label: 'Medium', shape: 'square' },
    { id: 'low', label: 'Low', shape: 'circle' },
  ];
  const LEVEL = Object.fromEntries(LEVELS.map((level) => [level.id, level]));

  const STATES = {
    live: 'Live, confirmed by visiting it',
    resolves: 'Resolves, not visited',
    offline: 'Offline',
    unreachable: 'Not serving pages',
    unknown: 'Not checked',
  };

  const FOUND = {
    kit: 'Runs the same scam kit',
    radar: 'Confirmed by Radar as running the same kit',
    filename: 'Serves the same kit file',
    hash: 'Serves a byte-identical file',
    title: 'Shows the same page title',
    tracker: 'Uses the same tracking ID',
    contact: 'Uses the same contact or wallet',
    certificate: 'Shares a TLS certificate',
    redirect: 'In the same redirect chain',
    'loads-from': 'Content loaded from it',
    ip: 'On the same dedicated server',
    mentions: 'Contacted by the same scanned page',
    query: 'Matched a hunt search',
    keyword: 'Blocklisted name matching a keyword',
    history: 'Earlier scan of the same site',
    batch: 'In a bulk-registration batch',
    listed: 'Already on a blocklist',
    triage: 'Suspicious name',
  };

  const SVG_NS = 'http://www.w3.org/2000/svg';
  const SHAPE_PATHS = {
    diamond: 'M5 0 10 5 5 10 0 5Z',
    triangle: 'M5 0.6 10 9.4 0 9.4Z',
    square: 'M1 1H9V9H1Z',
    circle: 'M5 0.5A4.5 4.5 0 1 1 5 9.5A4.5 4.5 0 1 1 5 0.5Z',
  };

  // The little shape that stands for a risk level in legends, chips and tables
  const mark = (levelId, hollow) => {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 10 10');
    svg.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', SHAPE_PATHS[LEVEL[levelId].shape]);
    path.setAttribute('fill', hollow ? 'none' : `var(--${levelId})`);
    path.setAttribute('stroke', `var(--${levelId})`);
    path.setAttribute('stroke-width', hollow ? '1.6' : '0');
    svg.append(path);
    return h('span', { class: 'mark' }, svg);
  };

  const levelBadge = (levelId, text) =>
    h('span', { class: 'level' }, mark(levelId), text || LEVEL[levelId].label);

  const defang = (value) => {
    const text = String(value == null ? '' : value);
    const match = text.match(/^(https?):\/\/([^/?#]+)(.*)$/i);
    if (match)
      return `${match[1].toLowerCase().replace('http', 'hxxp')}://${match[2].replace(/\./g, '[.]')}${match[3]}`;
    return text.replace(/\./g, '[.]');
  };

  const shorten = (text, max) => {
    const value = String(text == null ? '' : text);
    return value.length > max ? `${value.slice(0, max - 1)}…` : value;
  };

  const stripEmoji = (text) =>
    String(text || '')
      .replace(/[\p{Extended_Pictographic}\p{Regional_Indicator}\u200d\ufe0f\u20e3]/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim();

  const day = (value) => (value ? String(value).slice(0, 10) : '—');
  const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;

  let regionNames = null;
  try {
    regionNames = new Intl.DisplayNames(['en'], { type: 'region' });
  } catch {
    // Older browsers just show the two-letter code
  }
  const countryName = (code) => {
    try {
      return (regionNames && regionNames.of(code)) || code;
    } catch {
      return code;
    }
  };

  const hostingOf = (domain) => {
    const first = (domain.network || [])[0];
    if (!first) return null;
    return first.shared || first.asnName || (first.asn ? `AS${first.asn}` : null);
  };

  // ---------------------------------------------------------------- state

  const model = {
    data: null,
    domains: [],
    byName: new Map(),
    campaigns: new Map(),
    links: [],
    linksOf: new Map(),
    seed: null,
  };
  const ui = {
    view: 'globe',
    spin: !(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches),
    groupBy: 'campaign',
    query: '',
    levels: new Set(LEVELS.map((level) => level.id)),
    selected: null,
    focusLink: null,
    hover: null,
    sort: { key: 'score', dir: -1 },
    rowsShown: 60,
    campaignsShown: 12,
  };
  const scene = { nodes: [], edges: [], radius: 300, rings: [] };
  const camera = {
    x: 0,
    y: 0,
    k: 1,
    yaw: 0,
    pitch: 0,
    cosYaw: 1,
    sinYaw: 0,
    cosPitch: 1,
    sinPitch: 0,
  };

  // Point the 3D camera. The tilt is capped so the globe never flips upside down
  const aim = (yaw, pitch) => {
    camera.yaw = yaw;
    camera.pitch = Math.max(-1.35, Math.min(1.35, pitch));
    camera.cosYaw = Math.cos(camera.yaw);
    camera.sinYaw = Math.sin(camera.yaw);
    camera.cosPitch = Math.cos(camera.pitch);
    camera.sinPitch = Math.sin(camera.pitch);
  };
  aim(-0.6, 0.38);

  const campaignOf = (domain) => (domain.campaign ? model.campaigns.get(domain.campaign) : null);

  const DIMENSIONS = {
    campaign: {
      label: 'Campaign (same lure)',
      of: (domain) => {
        const campaign = campaignOf(domain);
        return campaign ? [campaign.id, campaign.label] : ['~', 'No lure captured'];
      },
    },
    target: {
      label: 'Country targeted',
      of: (domain) =>
        domain.targets[0]
          ? [domain.targets[0].country, countryName(domain.targets[0].country)]
          : ['~', 'No clear target'],
    },
    found: {
      label: 'How it was linked',
      of: (domain) => {
        const type = (domain.foundBy[0] || {}).type;
        return type ? [type, FOUND[type] || type] : ['~', 'Starting point'];
      },
    },
    registered: {
      label: 'Registration date',
      of: (domain) =>
        domain.created ? [day(domain.created), day(domain.created)] : ['~', 'Date unknown'],
    },
    registrar: {
      label: 'Registrar',
      of: (domain) => {
        const name = domain.registration && domain.registration.registrar;
        return name ? [name, name] : ['~', 'Registrar not looked up'];
      },
    },
    nameservers: {
      label: 'Nameserver pair',
      of: (domain) =>
        domain.nameservers
          ? [domain.nameservers.key, domain.nameservers.key.replace(/\.ns\.cloudflare\.com/g, '')]
          : ['~', 'Unknown'],
    },
    hosting: {
      label: 'Hosting network',
      of: (domain) => {
        const name = hostingOf(domain);
        return name ? [name, name] : ['~', 'Unknown'];
      },
    },
    tld: {
      label: 'Domain ending',
      of: (domain) => {
        const tld = `.${domain.domain.split('.').pop()}`;
        return [tld, tld];
      },
    },
    category: {
      label: 'Type of scam',
      of: (domain) => {
        const name =
          domain.category ||
          (domain.kits[0] && domain.kits[0].name) ||
          (domain.lures[0] && domain.lures[0].label);
        return name ? [name, name] : ['~', 'Type not established'];
      },
    },
    level: {
      label: 'Risk level',
      of: (domain) => [domain.risk.level, LEVEL[domain.risk.level].label],
    },
    state: {
      label: 'Online or offline',
      of: (domain) => [domain.state, STATES[domain.state] || domain.state],
    },
  };

  const searchText = (domain) => {
    if (!domain.searchText) {
      const campaign = campaignOf(domain);
      domain.searchText = [
        domain.domain,
        domain.title,
        campaign && campaign.label,
        campaign && campaign.brand,
        domain.targets
          .map((target) => `${target.country} ${countryName(target.country)}`)
          .join(' '),
        domain.registration && domain.registration.registrar,
        domain.state,
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
    }
    return domain.searchText;
  };

  const matches = (domain) =>
    ui.levels.has(domain.risk.level) && (!ui.query || searchText(domain).includes(ui.query));
  const visibleDomains = () => model.domains.filter(matches);

  // Links worth drawing between sites: specific ones, not something nearly every site shares
  const tellingLinks = (domain) => {
    const ceiling = Math.max(12, model.domains.length * 0.35);
    return (model.linksOf.get(domain.domain) || []).filter(
      (link) => link.kind !== 'naming' && link.domains.length <= ceiling,
    );
  };

  const relatedTo = (domain) => {
    const names = new Set();
    for (const link of tellingLinks(domain)) for (const name of link.domains) names.add(name);
    names.delete(domain.domain);
    return names;
  };

  // ---------------------------------------------------------------- layout

  const HUB_RADIUS = 118;
  const LEAF_RADIUS = 186;
  const ROW_GAP = 15;
  const LEAF_GAP = 14;

  const groupDomains = (domains) => {
    const groups = new Map();
    for (const domain of domains) {
      const [key, label] = DIMENSIONS[ui.groupBy].of(domain);
      if (!groups.has(key)) groups.set(key, { key, label, items: [] });
      groups.get(key).items.push(domain);
    }
    return [...groups.values()].sort(
      (a, b) => b.items.length - a.items.length || String(a.label).localeCompare(String(b.label)),
    );
  };

  // Radial tree: the starting point in the middle, one wedge per group, riskiest sites innermost
  const layoutTree = () => {
    const nodes = [];
    const edges = [];
    const seed = model.seed;
    const root = {
      id: 'root',
      type: seed ? 'seed' : 'root',
      x: 0,
      y: 0,
      domain: seed,
      label: seed ? seed.domain : model.rootLabel,
    };
    nodes.push(root);
    const groups = groupDomains(visibleDomains().filter((domain) => domain !== seed));
    const weights = groups.map((group) => Math.pow(group.items.length, 0.62) + 0.5);
    const total = weights.reduce((sum, weight) => sum + weight, 0) || 1;
    const gap = groups.length > 1 ? Math.min(0.035, 0.8 / groups.length) : 0;
    const usable = Math.PI * 2 - gap * groups.length;
    let angle = -Math.PI / 2;
    let radius = LEAF_RADIUS;

    groups.forEach((group, index) => {
      const span = (usable * weights[index]) / total;
      const mid = angle + span / 2;
      const hub = {
        id: `group:${group.key}`,
        type: 'hub',
        x: Math.cos(mid) * HUB_RADIUS,
        y: Math.sin(mid) * HUB_RADIUS,
        angle: mid,
        label: group.label,
        key: group.key,
        members: group.items,
        count: group.items.length,
      };
      nodes.push(hub);
      edges.push({ from: root, to: hub, kind: 'spine' });

      const items = group.items
        .slice()
        .sort((a, b) => b.risk.score - a.risk.score || a.domain.localeCompare(b.domain));
      let placed = 0;
      let row = 0;
      while (placed < items.length) {
        const r = LEAF_RADIUS + row * ROW_GAP;
        const capacity = Math.max(1, Math.floor((span * 0.92 * r) / LEAF_GAP));
        const take = Math.min(capacity, items.length - placed);
        for (let slot = 0; slot < take; slot += 1) {
          const theta = mid + (slot - (take - 1) / 2) * (LEAF_GAP / r);
          const node = {
            id: `domain:${items[placed + slot].domain}`,
            type: 'domain',
            x: Math.cos(theta) * r,
            y: Math.sin(theta) * r,
            domain: items[placed + slot],
            hub,
          };
          nodes.push(node);
          edges.push({ from: hub, to: node, kind: 'leaf' });
        }
        placed += take;
        row += 1;
      }
      hub.outer = LEAF_RADIUS + row * ROW_GAP;
      radius = Math.max(radius, hub.outer);
      angle += span + gap;
    });

    scene.nodes = nodes;
    scene.edges = edges;
    scene.radius = radius;
    scene.rings = [HUB_RADIUS, LEAF_RADIUS - ROW_GAP / 2, radius];
  };

  const GLOBE_HUB = 150;
  const GLOBE_SURFACE = 250;
  const GOLDEN_ANGLE = 2.399963229728653;

  // 3D: the starting point at the core of a globe, each group a cluster on its surface.
  // Groups are spread evenly (a Fibonacci sphere); within a group the riskiest site sits
  // at the centre of its patch and the rest spiral outward
  const layoutGlobe = () => {
    const nodes = [];
    const edges = [];
    const seed = model.seed;
    const root = {
      id: 'root',
      type: seed ? 'seed' : 'root',
      x: 0,
      y: 0,
      z: 0,
      domain: seed,
      label: seed ? seed.domain : model.rootLabel,
    };
    nodes.push(root);
    const groups = groupDomains(visibleDomains().filter((domain) => domain !== seed));
    // Groups arrive biggest first. Dealing them out in strides, rather than in order,
    // scatters the big ones around the globe instead of piling them up at one pole
    const total = groups.length;
    let stride = Math.max(1, Math.round(total * 0.618));
    const shared = (a, b) => (b ? shared(b, a % b) : a);
    while (stride < total && shared(stride, total) !== 1) stride += 1;
    groups.forEach((group, order) => {
      const index = (order * stride) % total;
      const height = total === 1 ? 0 : 1 - (2 * (index + 0.5)) / total;
      const ring = Math.sqrt(1 - height * height);
      const turn = index * GOLDEN_ANGLE;
      const out = [Math.cos(turn) * ring, height, Math.sin(turn) * ring];
      const hub = {
        id: `group:${group.key}`,
        type: 'hub',
        x: out[0] * GLOBE_HUB,
        y: out[1] * GLOBE_HUB,
        z: out[2] * GLOBE_HUB,
        label: group.label,
        key: group.key,
        members: group.items,
        count: group.items.length,
      };
      nodes.push(hub);
      edges.push({ from: root, to: hub, kind: 'spine' });
      // Two directions lying flat on the globe at this point
      const up = Math.abs(out[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
      let u = [
        out[1] * up[2] - out[2] * up[1],
        out[2] * up[0] - out[0] * up[2],
        out[0] * up[1] - out[1] * up[0],
      ];
      const length = Math.hypot(u[0], u[1], u[2]) || 1;
      u = [u[0] / length, u[1] / length, u[2] / length];
      const v = [
        out[1] * u[2] - out[2] * u[1],
        out[2] * u[0] - out[0] * u[2],
        out[0] * u[1] - out[1] * u[0],
      ];
      const items = group.items
        .slice()
        .sort((a, b) => b.risk.score - a.risk.score || a.domain.localeCompare(b.domain));
      items.forEach((domain, position) => {
        const spread = 9.5 * Math.sqrt(position + 0.4);
        const angle = position * GOLDEN_ANGLE;
        const cos = Math.cos(angle);
        const sin = Math.sin(angle);
        const point = [0, 1, 2].map(
          (axis) => out[axis] * GLOBE_SURFACE + (u[axis] * cos + v[axis] * sin) * spread,
        );
        const scale = GLOBE_SURFACE / Math.hypot(point[0], point[1], point[2]);
        const node = {
          id: `domain:${domain.domain}`,
          type: 'domain',
          x: point[0] * scale,
          y: point[1] * scale,
          z: point[2] * scale,
          domain,
          hub,
        };
        nodes.push(node);
        edges.push({ from: hub, to: node, kind: 'leaf' });
      });
    });
    scene.nodes = nodes;
    scene.edges = edges;
    scene.radius = GLOBE_SURFACE + 12;
    scene.rings = [];
  };

  // A small repeatable random source, so the network settles the same way every time
  const randomSource = (seedValue) => {
    let value = seedValue >>> 0;
    return () => {
      value = (value + 0x6d2b79f5) >>> 0;
      let t = Math.imul(value ^ (value >>> 15), 1 | value);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  };

  // Network: sites pulled toward whatever they have in common, pushed apart otherwise
  const layoutNetwork = () => {
    const random = randomSource(7);
    const domains = visibleDomains();
    const shown = new Set(domains.map((domain) => domain.domain));
    const nodes = [];
    const edges = [];
    const nodeOf = new Map();
    const campaignIds = [...new Set(domains.map((domain) => domain.campaign).filter(Boolean))];

    campaignIds.forEach((id, index) => {
      const campaign = model.campaigns.get(id);
      const theta = (index / campaignIds.length) * Math.PI * 2;
      const node = {
        id: `group:${id}`,
        type: 'hub',
        kind: 'campaign',
        key: id,
        label: campaign.label,
        x: Math.cos(theta) * 260,
        y: Math.sin(theta) * 260,
        members: [],
        count: 0,
      };
      nodes.push(node);
      nodeOf.set(node.id, node);
    });
    for (const domain of domains) {
      const anchor = nodeOf.get(`group:${domain.campaign}`);
      const node = {
        id: `domain:${domain.domain}`,
        type: domain === model.seed ? 'seed' : 'domain',
        domain,
        label: domain.domain,
        x: (anchor ? anchor.x : 0) + (random() - 0.5) * 120,
        y: (anchor ? anchor.y : 0) + (random() - 0.5) * 120,
      };
      nodes.push(node);
      nodeOf.set(node.id, node);
      if (anchor) {
        anchor.members.push(domain);
        anchor.count += 1;
        edges.push({ from: node, to: anchor, kind: 'campaign', rest: 30, strength: 0.5 });
      }
    }
    const ceiling = Math.max(12, domains.length * 0.6);
    for (const link of model.links) {
      if (link.kind === 'naming') continue;
      const members = link.domains.filter((name) => shown.has(name));
      if (members.length < 2 || members.length > ceiling) continue;
      const node = {
        id: `link:${link.id}`,
        type: 'attribute',
        link,
        label: `${link.kindLabel}: ${link.label}`,
        x: (random() - 0.5) * 200,
        y: (random() - 0.5) * 200,
        count: members.length,
      };
      nodes.push(node);
      for (const name of members)
        edges.push({
          from: nodeOf.get(`domain:${name}`),
          to: node,
          kind: 'link',
          rest: 70,
          strength: 0.12,
        });
    }

    // Spring layout (Fruchterman-Reingold): everything repels nearby things, links pull
    // their ends together, and each step is capped by a "temperature" that cools to zero
    const ideal = 30;
    const reach = ideal * 3.2;
    const rounds = nodes.length > 1400 ? 110 : nodes.length > 700 ? 180 : 300;
    for (let round = 0; round < rounds; round += 1) {
      const temperature = (1 - round / rounds) * 26 + 0.5;
      const grid = new Map();
      for (const node of nodes) {
        node.fx = -node.x * 0.035;
        node.fy = -node.y * 0.035;
        const key = `${Math.floor(node.x / reach)},${Math.floor(node.y / reach)}`;
        if (!grid.has(key)) grid.set(key, []);
        grid.get(key).push(node);
      }
      for (const node of nodes) {
        const gx = Math.floor(node.x / reach);
        const gy = Math.floor(node.y / reach);
        for (let dx = -1; dx <= 1; dx += 1) {
          for (let dy = -1; dy <= 1; dy += 1) {
            for (const other of grid.get(`${gx + dx},${gy + dy}`) || []) {
              if (other === node) continue;
              let ox = node.x - other.x;
              let oy = node.y - other.y;
              let distance = Math.hypot(ox, oy);
              if (distance < 0.5) {
                ox = random() - 0.5;
                oy = random() - 0.5;
                distance = 0.5;
              }
              if (distance > reach) continue;
              const push = Math.min(ideal * 4, (ideal * ideal) / distance) / distance;
              node.fx += ox * push;
              node.fy += oy * push;
            }
          }
        }
      }
      for (const edge of edges) {
        const ox = edge.to.x - edge.from.x;
        const oy = edge.to.y - edge.from.y;
        const distance = Math.hypot(ox, oy) || 1;
        const pull =
          (Math.min(distance, (distance * distance) / edge.rest) * edge.strength) / distance;
        edge.from.fx += ox * pull;
        edge.from.fy += oy * pull;
        edge.to.fx -= ox * pull;
        edge.to.fy -= oy * pull;
      }
      for (const node of nodes) {
        const force = Math.hypot(node.fx, node.fy) || 1;
        const step = Math.min(force, temperature);
        node.x += (node.fx / force) * step;
        node.y += (node.fy / force) * step;
      }
    }

    scene.nodes = nodes;
    scene.edges = edges;
    scene.radius = nodes.reduce((max, node) => Math.max(max, Math.hypot(node.x, node.y)), 120) + 30;
    scene.rings = [];
  };

  const layout = () => {
    if (ui.view === 'network') layoutNetwork();
    else if (ui.view === 'globe') layoutGlobe();
    else layoutTree();
  };

  // ---------------------------------------------------------------- canvas

  const canvas = byId('map');
  const context = canvas.getContext('2d');
  const view = { width: 0, height: 0, ratio: 1 };
  let colors = {};
  let frame = 0;

  const readColors = () => {
    const style = getComputedStyle(document.documentElement);
    const read = (name) => style.getPropertyValue(`--${name}`).trim();
    colors = Object.fromEntries(
      [
        'surface',
        'line',
        'line-soft',
        'ink',
        'ink-2',
        'ink-3',
        'accent',
        'critical',
        'high',
        'medium',
        'low',
      ].map((name) => [name, read(name)]),
    );
    colors.sans = read('font-sans') || 'sans-serif';
    colors.mono = read('font-mono') || 'monospace';
  };

  const FOCAL = 900;

  // Where a node lands on screen. In 3D the scene is turned by the camera's angles and
  // then foreshortened; each node keeps its depth and scale so it can be sized and sorted
  const toScreen = (node) => {
    if (ui.view !== 'globe') {
      return [
        view.width / 2 + camera.x + node.x * camera.k,
        view.height / 2 + camera.y + node.y * camera.k,
      ];
    }
    const z = node.z || 0;
    const x = node.x * camera.cosYaw + z * camera.sinYaw;
    const back = z * camera.cosYaw - node.x * camera.sinYaw;
    const y = node.y * camera.cosPitch - back * camera.sinPitch;
    node.depth = node.y * camera.sinPitch + back * camera.cosPitch;
    node.scale = FOCAL / (FOCAL + node.depth);
    return [
      view.width / 2 + camera.x + x * camera.k * node.scale,
      view.height / 2 + camera.y + y * camera.k * node.scale,
    ];
  };

  // Room to leave around the drawing for the labels that sit outside it
  const margin = () => {
    if (ui.view === 'tree') return view.width < 560 ? 84 : 128;
    return ui.view === 'globe' ? (view.width < 560 ? 26 : 56) : 30;
  };

  const fit = () => {
    const room = Math.max(60, Math.min(view.width, view.height) / 2 - margin());
    camera.k = Math.min(2.5, room / scene.radius);
    camera.x = 0;
    camera.y = 0;
  };

  // On a crowded globe the marks shrink, so several hundred sites don't merge into one blob
  const leafSize = () => {
    const base = Math.max(2.6, Math.min(8, 3.3 * Math.pow(camera.k, 0.6)));
    if (ui.view !== 'globe') return base;
    return base * Math.max(0.5, Math.min(1, Math.sqrt(320 / Math.max(1, scene.nodes.length))));
  };

  const tracePath = (shape, x, y, r) => {
    context.beginPath();
    if (shape === 'diamond') {
      const d = r * 1.25;
      context.moveTo(x, y - d);
      context.lineTo(x + d, y);
      context.lineTo(x, y + d);
      context.lineTo(x - d, y);
      context.closePath();
    } else if (shape === 'triangle') {
      const d = r * 1.2;
      context.moveTo(x, y - d);
      context.lineTo(x + d, y + d * 0.82);
      context.lineTo(x - d, y + d * 0.82);
      context.closePath();
    } else if (shape === 'square') {
      const d = r * 0.9;
      context.rect(x - d, y - d, d * 2, d * 2);
    } else {
      context.arc(x, y, r, 0, Math.PI * 2);
    }
  };

  // One site: shape and colour by risk level, hollow when it is offline
  const drawSite = (domain, x, y, r, alpha) => {
    const level = LEVEL[domain.risk.level];
    const hollow = domain.state === 'offline' || domain.state === 'unreachable';
    context.globalAlpha = alpha;
    tracePath(level.shape, x, y, r);
    // A ring in the surface colour keeps neighbours apart without drawing borders
    context.lineWidth = 2.5;
    context.strokeStyle = colors.surface;
    context.stroke();
    if (hollow) {
      tracePath(level.shape, x, y, r * 0.82);
      context.fillStyle = colors.surface;
      context.fill();
      context.lineWidth = 1.5;
      context.strokeStyle = colors[level.id];
      context.stroke();
    } else {
      context.fillStyle = colors[level.id];
      context.fill();
    }
    context.globalAlpha = 1;
  };

  const haloText = (text, x, y) => {
    context.lineWidth = 3;
    context.strokeStyle = colors.surface;
    context.lineJoin = 'round';
    context.strokeText(text, x, y);
    context.fillText(text, x, y);
  };

  // Which nodes to keep bright: the members of a focused link, or a selected site's relatives
  const focusSet = () => {
    if (ui.focusLink) return new Set(ui.focusLink.domains);
    // The starting point is linked to everything, so selecting it dims nothing
    if (ui.selected && ui.selected.type === 'domain' && ui.selected.domain !== model.seed) {
      const related = relatedTo(ui.selected.domain);
      if (related.size) {
        related.add(ui.selected.domain.domain);
        return related;
      }
    }
    if (ui.selected && ui.selected.type === 'group')
      return new Set(ui.selected.members.map((domain) => domain.domain));
    return null;
  };

  const hubSize = (node) =>
    Math.max(3, Math.min(13, (2.2 + Math.sqrt(node.count || 1)) * Math.pow(camera.k, 0.4)));

  const drawRadialLabels = (hubs) => {
    const narrow = view.width < 560;
    context.font = `11px ${colors.sans}`;
    context.textBaseline = 'middle';
    const kept = [];
    const order = hubs.slice().sort((a, b) => b.count - a.count);
    for (const hub of order) {
      const reach = (hub.outer + 9) * camera.k;
      const forced =
        ui.hover === hub ||
        (ui.selected && ui.selected.type === 'group' && ui.selected.key === hub.key);
      const clash = kept.some((other) => {
        let delta = Math.abs(other.angle - hub.angle);
        if (delta > Math.PI) delta = Math.PI * 2 - delta;
        return delta * Math.min(reach, other.reach) < 13;
      });
      if (clash && !forced) continue;
      kept.push({ angle: hub.angle, reach });
      const x = view.width / 2 + camera.x + Math.cos(hub.angle) * reach;
      const y = view.height / 2 + camera.y + Math.sin(hub.angle) * reach;
      const flipped = Math.cos(hub.angle) < 0;
      context.save();
      context.translate(x, y);
      context.rotate(flipped ? hub.angle + Math.PI : hub.angle);
      context.textAlign = flipped ? 'right' : 'left';
      context.fillStyle = forced ? colors.ink : colors['ink-2'];
      context.fillText(`${shorten(stripEmoji(hub.label), narrow ? 11 : 17)} · ${hub.count}`, 0, 0);
      context.restore();
    }
  };

  const drawNetworkLabels = (hubs) => {
    context.font = `11px ${colors.sans}`;
    context.textBaseline = 'middle';
    context.textAlign = 'left';
    const boxes = [];
    for (const hub of hubs.slice().sort((a, b) => b.count - a.count)) {
      const forced = ui.hover === hub;
      if (hub.count < 3 && !forced) continue;
      const [x, y] = toScreen(hub);
      const text = `${shorten(stripEmoji(hub.label), 24)} · ${hub.count}`;
      const width = context.measureText(text).width;
      const box = {
        left: x + hubSize(hub) + 4,
        top: y - 7,
        right: x + hubSize(hub) + 4 + width,
        bottom: y + 7,
      };
      if (
        !forced &&
        boxes.some(
          (other) =>
            box.left < other.right &&
            box.right > other.left &&
            box.top < other.bottom &&
            box.bottom > other.top,
        )
      )
        continue;
      boxes.push(box);
      context.fillStyle = forced ? colors.ink : colors['ink-2'];
      haloText(text, box.left, y);
    }
  };

  // Three hoops (an equator and two meridians) that turn with the globe, for a sense of depth
  const HOOPS = [0, 1, 2].map((axis) =>
    Array.from({ length: 49 }, (unused, step) => {
      const angle = (step / 48) * Math.PI * 2;
      const a = Math.cos(angle) * GLOBE_SURFACE;
      const b = Math.sin(angle) * GLOBE_SURFACE;
      if (axis === 0) return { x: a, y: 0, z: b };
      return axis === 1 ? { x: a, y: b, z: 0 } : { x: 0, y: a, z: b };
    }),
  );

  const drawGlobe = (focus) => {
    const span = scene.radius;
    const lit = (node) => !focus || (node.domain && focus.has(node.domain.domain));
    // Things on the far side fade, which is most of what makes it read as a solid
    const fade = (node) => Math.max(0.24, Math.min(1, 0.64 - (node.depth / span) * 0.44));

    for (const node of scene.nodes) {
      const [x, y] = toScreen(node);
      node.sx = x;
      node.sy = y;
    }

    context.lineWidth = 1;
    context.strokeStyle = colors['line-soft'];
    for (const hoop of HOOPS) {
      context.beginPath();
      hoop.forEach((point, index) => {
        const [x, y] = toScreen(point);
        if (index) context.lineTo(x, y);
        else context.moveTo(x, y);
      });
      context.stroke();
    }

    for (const edge of scene.edges) {
      const strength = edge.kind === 'spine' ? 0.5 : lit(edge.to) ? 0.17 : 0.04;
      context.globalAlpha = strength * fade(edge.to);
      context.strokeStyle = edge.kind === 'spine' ? colors.line : colors['ink-3'];
      context.beginPath();
      context.moveTo(edge.from.sx, edge.from.sy);
      context.lineTo(edge.to.sx, edge.to.sy);
      context.stroke();
    }
    context.globalAlpha = 1;

    const size = leafSize();
    const hubs = [];
    let core = null;
    const order = scene.nodes.slice().sort((a, b) => b.depth - a.depth);
    for (const node of order) {
      if (node.type === 'domain') {
        const alpha = (lit(node) ? 1 : 0.25) * fade(node);
        drawSite(node.domain, node.sx, node.sy, size * node.scale, alpha);
      } else if (node.type === 'hub') {
        hubs.push(node);
        const chosen = ui.selected && ui.selected.type === 'group' && ui.selected.key === node.key;
        context.globalAlpha = fade(node);
        context.beginPath();
        context.arc(node.sx, node.sy, hubSize(node) * node.scale, 0, Math.PI * 2);
        context.fillStyle = colors.surface;
        context.fill();
        context.lineWidth = chosen || ui.hover === node ? 2.2 : 1.4;
        context.strokeStyle = chosen ? colors.accent : colors['ink-2'];
        context.stroke();
        context.globalAlpha = 1;
      } else {
        const isSeed = node.type === 'seed';
        const r = Math.max(7, size * 2);
        context.beginPath();
        context.arc(node.sx, node.sy, r + 5, 0, Math.PI * 2);
        context.fillStyle = isSeed ? colors.surface : colors.accent;
        context.fill();
        context.lineWidth = 2;
        context.strokeStyle = colors.accent;
        context.stroke();
        if (isSeed) drawSite(node.domain, node.sx, node.sy, r, 1);
        core = { node, r, isSeed };
      }
    }

    // The name at the centre goes on after everything else, so nothing nearer covers it
    if (core) {
      context.font = `600 12px ${core.isSeed ? colors.mono : colors.sans}`;
      context.textAlign = 'center';
      context.textBaseline = 'top';
      context.fillStyle = colors.ink;
      const name = core.isSeed ? defang(core.node.domain.domain) : shorten(core.node.label, 30);
      haloText(name, core.node.sx, core.node.sy + core.r + 9);
    }

    // Name the groups on the near side, biggest first, skipping any that would overlap
    context.font = `11px ${colors.sans}`;
    context.textBaseline = 'middle';
    const narrow = view.width < 560;
    const boxes = [];
    for (const hub of hubs.slice().sort((a, b) => b.count - a.count)) {
      const forced =
        ui.hover === hub ||
        (ui.selected && ui.selected.type === 'group' && ui.selected.key === hub.key);
      if (hub.depth > span * 0.12 && !forced) continue;
      // Past a few dozen names the globe turns to noise; the rest appear on hover
      if (boxes.length >= (narrow ? 12 : 30) && !forced) continue;
      const text = `${shorten(stripEmoji(hub.label), narrow ? 14 : 24)} · ${hub.count}`;
      const width = context.measureText(text).width;
      // Labels point away from the middle, unless that would run them off the edge
      const reach = hubSize(hub) * hub.scale + 5;
      let left = hub.sx < view.width / 2 + camera.x;
      if (left && hub.sx - reach - width < 4) left = false;
      else if (!left && hub.sx + reach + width > view.width - 4) left = true;
      const start = hub.sx + (left ? -1 : 1) * reach;
      const box = {
        left: left ? start - width : start,
        right: left ? start : start + width,
        top: hub.sy - 7,
        bottom: hub.sy + 7,
      };
      const clash = boxes.some(
        (other) =>
          box.left < other.right &&
          box.right > other.left &&
          box.top < other.bottom &&
          box.bottom > other.top,
      );
      if (clash && !forced) continue;
      boxes.push(box);
      context.textAlign = left ? 'right' : 'left';
      context.globalAlpha = forced ? 1 : fade(hub);
      context.fillStyle = forced ? colors.ink : colors['ink-2'];
      haloText(text, start, hub.sy);
    }
    context.globalAlpha = 1;

    for (const node of scene.nodes) {
      const chosen =
        ui.selected && ui.selected.type === 'domain' && node.domain === ui.selected.domain;
      if (node.type !== 'domain' || (!chosen && ui.hover !== node)) continue;
      const r = size * node.scale;
      context.beginPath();
      context.arc(node.sx, node.sy, r + 4.5, 0, Math.PI * 2);
      context.lineWidth = chosen ? 2.2 : 1.5;
      context.strokeStyle = chosen ? colors.accent : colors.ink;
      context.stroke();
      context.font = `600 11px ${colors.mono}`;
      context.textBaseline = 'middle';
      const left = node.sx > view.width / 2;
      context.textAlign = left ? 'right' : 'left';
      context.fillStyle = colors.ink;
      haloText(defang(node.domain.domain), node.sx + (left ? -1 : 1) * (r + 9), node.sy);
    }
  };

  const draw = () => {
    frame = 0;
    const { width, height } = view;
    context.setTransform(view.ratio, 0, 0, view.ratio, 0, 0);
    context.clearRect(0, 0, width, height);
    context.fillStyle = colors.surface;
    context.fillRect(0, 0, width, height);
    const cx = width / 2 + camera.x;
    const cy = height / 2 + camera.y;
    const focus = focusSet();
    if (ui.view === 'globe') {
      drawGlobe(focus);
      return;
    }
    const bright = (node) => !focus || (node.domain && focus.has(node.domain.domain));

    context.lineWidth = 1;
    context.strokeStyle = colors['line-soft'];
    for (const ring of scene.rings) {
      context.beginPath();
      context.arc(cx, cy, ring * camera.k, 0, Math.PI * 2);
      context.stroke();
    }

    for (const edge of scene.edges) {
      const [x1, y1] = toScreen(edge.from);
      const [x2, y2] = toScreen(edge.to);
      const lit = bright(
        edge.from.type === 'domain' || edge.from.type === 'seed' ? edge.from : edge.to,
      );
      context.globalAlpha =
        edge.kind === 'spine' ? 0.7 : lit ? (edge.kind === 'link' ? 0.3 : 0.24) : 0.06;
      context.strokeStyle =
        edge.kind === 'link'
          ? colors.accent
          : edge.kind === 'spine'
            ? colors.line
            : colors['ink-3'];
      context.beginPath();
      context.moveTo(x1, y1);
      context.lineTo(x2, y2);
      context.stroke();
    }
    context.globalAlpha = 1;

    // Lines from a selected site to the sites it shares something specific with
    if (ui.selected && ui.selected.type === 'domain' && focus && !ui.focusLink) {
      const origin = scene.nodes.find((node) => node.domain === ui.selected.domain);
      if (origin) {
        const [x1, y1] = toScreen(origin);
        context.strokeStyle = colors.accent;
        context.globalAlpha = 0.5;
        context.lineWidth = 1.2;
        for (const node of scene.nodes) {
          if (node === origin || !node.domain || !focus.has(node.domain.domain)) continue;
          const [x2, y2] = toScreen(node);
          context.beginPath();
          context.moveTo(x1, y1);
          context.quadraticCurveTo(
            (x1 + x2) / 2 + (cy - (y1 + y2) / 2) * 0.25,
            (y1 + y2) / 2 + ((x1 + x2) / 2 - cx) * 0.25,
            x2,
            y2,
          );
          context.stroke();
        }
        context.globalAlpha = 1;
      }
    }

    const size = leafSize();
    const hubs = [];
    for (const node of scene.nodes) {
      const [x, y] = toScreen(node);
      if (node.type === 'hub') {
        hubs.push(node);
        const r = hubSize(node);
        const chosen = ui.selected && ui.selected.type === 'group' && ui.selected.key === node.key;
        context.beginPath();
        context.arc(x, y, r, 0, Math.PI * 2);
        context.fillStyle = colors.surface;
        context.fill();
        context.lineWidth = chosen || ui.hover === node ? 2.2 : 1.4;
        context.strokeStyle = chosen ? colors.accent : colors['ink-2'];
        context.stroke();
      } else if (node.type === 'attribute') {
        const r = Math.max(2, Math.min(7, 1.5 + Math.sqrt(node.count) * 0.8));
        context.beginPath();
        context.arc(x, y, r, 0, Math.PI * 2);
        context.fillStyle = ui.focusLink === node.link ? colors.accent : colors['ink-3'];
        context.fill();
      } else if (node.type === 'root') {
        context.beginPath();
        context.arc(x, y, 7, 0, Math.PI * 2);
        context.fillStyle = colors.accent;
        context.fill();
      }
    }
    // Lowest risk first, so the sites that matter most end up on top
    for (const level of LEVELS.slice().reverse()) {
      for (const node of scene.nodes) {
        if (node.type !== 'domain' || node.domain.risk.level !== level.id) continue;
        const [x, y] = toScreen(node);
        if (x < -20 || y < -20 || x > width + 20 || y > height + 20) continue;
        drawSite(node.domain, x, y, size, bright(node) ? 1 : 0.28);
      }
    }

    const seedNode = scene.nodes.find((node) => node.type === 'seed');
    if (seedNode) {
      const [x, y] = toScreen(seedNode);
      const r = Math.max(7, size * 2);
      context.beginPath();
      context.arc(x, y, r + 5, 0, Math.PI * 2);
      context.fillStyle = colors.surface;
      context.fill();
      context.lineWidth = 2;
      context.strokeStyle = colors.accent;
      context.stroke();
      drawSite(seedNode.domain, x, y, r, 1);
      context.font = `600 12px ${colors.mono}`;
      context.textAlign = 'center';
      context.textBaseline = 'top';
      context.fillStyle = colors.ink;
      haloText(defang(seedNode.domain.domain), x, y + r + 9);
    } else {
      const rootNode = scene.nodes.find((node) => node.type === 'root');
      if (rootNode) {
        const [x, y] = toScreen(rootNode);
        context.font = `600 12px ${colors.sans}`;
        context.textAlign = 'center';
        context.textBaseline = 'top';
        context.fillStyle = colors.ink;
        haloText(shorten(rootNode.label, 30), x, y + 12);
      }
    }

    for (const node of scene.nodes) {
      const chosen =
        ui.selected && ui.selected.type === 'domain' && node.domain === ui.selected.domain;
      if ((node.type !== 'domain' && node.type !== 'seed') || (!chosen && ui.hover !== node))
        continue;
      const [x, y] = toScreen(node);
      const r = node.type === 'seed' ? Math.max(7, size * 2) + 5 : size;
      context.beginPath();
      context.arc(x, y, r + 4.5, 0, Math.PI * 2);
      context.lineWidth = chosen ? 2.2 : 1.5;
      context.strokeStyle = chosen ? colors.accent : colors.ink;
      context.stroke();
      if (node.type === 'domain') {
        context.font = `600 11px ${colors.mono}`;
        context.textBaseline = 'middle';
        const left = x > width / 2;
        context.textAlign = left ? 'right' : 'left';
        context.fillStyle = colors.ink;
        haloText(defang(node.domain.domain), x + (left ? -1 : 1) * (r + 9), y);
      }
    }

    if (ui.view === 'tree') drawRadialLabels(hubs);
    else drawNetworkLabels(hubs);
  };

  const requestDraw = () => {
    if (!frame) frame = requestAnimationFrame(draw);
  };

  const resize = () => {
    const box = canvas.getBoundingClientRect();
    if (!box.width || !box.height) return;
    view.width = box.width;
    view.height = box.height;
    view.ratio = Math.min(2.5, window.devicePixelRatio || 1);
    canvas.width = Math.round(box.width * view.ratio);
    canvas.height = Math.round(box.height * view.ratio);
  };

  // ---------------------------------------------------------------- pointer and keyboard

  const tooltip = byId('tooltip');
  const pointers = new Map();
  let drag = null;

  const nodeAt = (px, py) => {
    let best = null;
    let bestDistance = 24 * 24;
    for (const node of scene.nodes) {
      const [x, y] = toScreen(node);
      // In 3D, prefer what is on the near side over anything showing through from behind
      const behind = ui.view === 'globe' && node.depth > 0 ? 260 : 0;
      const distance = (x - px) * (x - px) + (y - py) * (y - py) + behind;
      if (distance < bestDistance) {
        best = node;
        bestDistance = distance;
      }
    }
    return best;
  };

  const showTooltip = (node, px, py) => {
    tooltip.replaceChildren();
    if (!node) {
      tooltip.hidden = true;
      return;
    }
    if (node.domain) {
      const domain = node.domain;
      tooltip.append(
        h('strong', null, defang(domain.domain)),
        h(
          'span',
          null,
          levelBadge(
            domain.risk.level,
            `${LEVEL[domain.risk.level].label} · ${domain.risk.score}/100`,
          ),
        ),
        domain.title ? h('span', null, shorten(domain.title, 70)) : null,
        h('span', null, STATES[domain.state] || domain.state),
      );
    } else if (node.type === 'hub') {
      tooltip.append(
        h('strong', { class: 'plain' }, shorten(stripEmoji(node.label), 80)),
        h('span', null, plural(node.count, 'site')),
      );
    } else if (node.type === 'attribute') {
      tooltip.append(
        h('strong', null, shorten(node.link.label, 80)),
        h('span', null, `${node.link.kindLabel} · ${plural(node.count, 'site')}`),
      );
    } else {
      tooltip.append(h('strong', { class: 'plain' }, node.label || 'Start'));
    }
    tooltip.hidden = false;
    const box = tooltip.getBoundingClientRect();
    tooltip.style.left = `${Math.max(6, Math.min(view.width - box.width - 6, px + 14))}px`;
    tooltip.style.top = `${Math.max(6, Math.min(view.height - box.height - 6, py + 14))}px`;
  };

  const localPoint = (event) => {
    const box = canvas.getBoundingClientRect();
    return [event.clientX - box.left, event.clientY - box.top];
  };

  const zoomAt = (px, py, factor) => {
    const next = Math.max(0.15, Math.min(8, camera.k * factor));
    if (ui.view === 'globe') {
      // The globe stays centred and simply grows or shrinks
      camera.k = next;
      requestDraw();
      return;
    }
    const wx = (px - view.width / 2 - camera.x) / camera.k;
    const wy = (py - view.height / 2 - camera.y) / camera.k;
    camera.k = next;
    camera.x = px - view.width / 2 - wx * next;
    camera.y = py - view.height / 2 - wy * next;
    requestDraw();
  };

  const selectNode = (node) => {
    if (!node) {
      ui.selected = null;
      ui.focusLink = null;
    } else if (node.domain) {
      ui.selected = { type: 'domain', domain: node.domain };
      ui.focusLink = null;
    } else if (node.type === 'hub') {
      ui.selected = { type: 'group', key: node.key, label: node.label, members: node.members };
      ui.focusLink = null;
    } else if (node.type === 'attribute') {
      ui.focusLink = node.link;
    }
    refreshPanels();
    requestDraw();
  };

  canvas.addEventListener('pointerdown', (event) => {
    canvas.setPointerCapture(event.pointerId);
    pointers.set(event.pointerId, localPoint(event));
    const [px, py] = localPoint(event);
    stopSpin();
    drag = {
      startX: px,
      startY: py,
      x: camera.x,
      y: camera.y,
      yaw: camera.yaw,
      pitch: camera.pitch,
      moved: false,
      pinch: null,
    };
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      drag.pinch = { distance: Math.hypot(a[0] - b[0], a[1] - b[1]) || 1 };
    }
  });

  canvas.addEventListener('pointermove', (event) => {
    const [px, py] = localPoint(event);
    if (pointers.has(event.pointerId)) pointers.set(event.pointerId, [px, py]);
    if (drag && pointers.size === 2 && drag.pinch) {
      const [a, b] = [...pointers.values()];
      const distance = Math.hypot(a[0] - b[0], a[1] - b[1]) || 1;
      zoomAt((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, distance / drag.pinch.distance);
      drag.pinch.distance = distance;
      drag.moved = true;
      return;
    }
    if (drag && pointers.size === 1) {
      const dx = px - drag.startX;
      const dy = py - drag.startY;
      if (!drag.moved && Math.hypot(dx, dy) < 5) return;
      drag.moved = true;
      if (ui.view === 'globe') {
        // Dragging turns the globe, as if you had hold of its surface
        aim(drag.yaw - dx * 0.0085, drag.pitch + dy * 0.0085);
      } else {
        camera.x = drag.x + dx;
        camera.y = drag.y + dy;
      }
      canvas.classList.add('dragging');
      showTooltip(null);
      requestDraw();
      return;
    }
    const node = nodeAt(px, py);
    if (node !== ui.hover) {
      ui.hover = node;
      canvas.classList.toggle('pointing', Boolean(node));
      requestDraw();
    }
    showTooltip(node, px, py);
  });

  const endPointer = (event) => {
    const wasDrag = drag && drag.moved;
    const [px, py] = localPoint(event);
    pointers.delete(event.pointerId);
    canvas.classList.remove('dragging');
    if (pointers.size === 0) {
      if (drag && !wasDrag && event.type === 'pointerup') selectNode(nodeAt(px, py));
      drag = null;
    } else if (drag) {
      // One finger lifted from a pinch: carry on panning from where the other one is
      const [rest] = [...pointers.values()];
      drag = {
        startX: rest[0],
        startY: rest[1],
        x: camera.x,
        y: camera.y,
        yaw: camera.yaw,
        pitch: camera.pitch,
        moved: true,
        pinch: null,
      };
    }
  };
  canvas.addEventListener('pointerup', endPointer);
  canvas.addEventListener('pointercancel', endPointer);
  canvas.addEventListener('pointerleave', () => {
    if (pointers.size) return;
    ui.hover = null;
    showTooltip(null);
    requestDraw();
  });

  // Plain scrolling moves the page; hold Ctrl (or pinch a trackpad) to zoom the map
  canvas.addEventListener(
    'wheel',
    (event) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      stopSpin();
      const [px, py] = localPoint(event);
      zoomAt(px, py, Math.exp(-event.deltaY * 0.012));
    },
    { passive: false },
  );
  canvas.addEventListener('dblclick', (event) => {
    const [px, py] = localPoint(event);
    zoomAt(px, py, 1.6);
  });
  canvas.addEventListener('keydown', (event) => {
    const step = 40;
    const moves = {
      ArrowLeft: [step, 0],
      ArrowRight: [-step, 0],
      ArrowUp: [0, step],
      ArrowDown: [0, -step],
    };
    if (moves[event.key] && ui.view === 'globe') {
      stopSpin();
      aim(camera.yaw + moves[event.key][0] * 0.004, camera.pitch - moves[event.key][1] * 0.004);
    } else if (moves[event.key]) {
      camera.x += moves[event.key][0];
      camera.y += moves[event.key][1];
    } else if (event.key === '+' || event.key === '=') {
      zoomAt(view.width / 2, view.height / 2, 1.3);
    } else if (event.key === '-') {
      zoomAt(view.width / 2, view.height / 2, 1 / 1.3);
    } else if (event.key === '0') {
      fit();
    } else {
      return;
    }
    event.preventDefault();
    requestDraw();
  });

  byId('zoom-in').addEventListener('click', () => zoomAt(view.width / 2, view.height / 2, 1.4));
  byId('zoom-out').addEventListener('click', () =>
    zoomAt(view.width / 2, view.height / 2, 1 / 1.4),
  );
  byId('zoom-fit').addEventListener('click', () => {
    fit();
    requestDraw();
  });

  // The globe turns slowly by itself until someone takes hold of it
  let spinning = 0;
  const spinButton = byId('spin');
  const spinStep = () => {
    spinning = 0;
    if (!ui.spin || ui.view !== 'globe' || !model.data || document.hidden) return;
    aim(camera.yaw + 0.0026, camera.pitch);
    draw();
    spinning = requestAnimationFrame(spinStep);
  };
  const startSpin = () => {
    spinButton.setAttribute('aria-pressed', String(ui.spin));
    if (ui.spin && ui.view === 'globe' && !spinning) spinning = requestAnimationFrame(spinStep);
  };
  function stopSpin() {
    if (!ui.spin) return;
    ui.spin = false;
    spinButton.setAttribute('aria-pressed', 'false');
  }
  spinButton.addEventListener('click', () => {
    ui.spin = !ui.spin;
    startSpin();
  });
  document.addEventListener('visibilitychange', startSpin);

  // ---------------------------------------------------------------- panels

  const copyText = async (text, button, done) => {
    const original = button.textContent;
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // Clipboard access can be refused, so fall back to a selection the browser will copy
      const area = h('textarea', { 'aria-hidden': 'true' });
      area.value = text;
      area.style.cssText = 'position:fixed;opacity:0;top:0;left:0';
      document.body.append(area);
      area.select();
      try {
        document.execCommand('copy');
      } catch {
        done = 'Copy failed';
      }
      area.remove();
    }
    button.textContent = done;
    setTimeout(() => {
      button.textContent = original;
    }, 1600);
  };

  const fact = (label, value) => (value ? [h('dt', null, label), h('dd', null, value)] : []);

  const weightTicks = (weight) => {
    const filled = weight >= 0.5 ? 3 : weight >= 0.25 ? 2 : 1;
    const label = ['', 'Minor', 'Moderate', 'Major'][filled];
    return h(
      'span',
      { class: 'weight', role: 'img', 'aria-label': `${label} factor`, title: `${label} factor` },
      [1, 2, 3].map((tick) => h('i', { class: tick <= filled ? 'on' : '' })),
    );
  };

  const selectDomain = (domain, scroll) => {
    ui.selected = { type: 'domain', domain };
    ui.focusLink = null;
    refreshPanels();
    requestDraw();
    if (scroll) byId('record').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  };

  const stamp = (value) => (value ? `${String(value).slice(0, 16).replace('T', ' ')} UTC` : null);

  // What Radar has seen of a site over time: how long it has lasted and what changed
  const trackingBlock = (track) => {
    const window = track.takedownWindow;
    return h(
      'div',
      { class: 'record-block' },
      h('h4', null, 'Tracking'),
      h(
        'dl',
        { class: 'facts' },
        fact('Watched since', stamp(track.firstSeen)),
        fact(
          'Visits',
          track.checks ? `${track.checks}, up on ${track.uptime}% of them` : 'Not visited yet',
        ),
        fact(
          'Taken down',
          window ? `Between ${stamp(window.after)} and ${stamp(window.before)}` : null,
        ),
        fact('Down since', !window && track.downSince ? stamp(track.downSince) : null),
        fact('Why it is down', track.downReason),
        fact('Last visit', stamp(track.lastCheck)),
        fact('Changes seen', track.changes ? String(track.changes) : null),
        fact('Popularity', track.popularity),
        fact('Why watched', track.why),
      ),
      track.events && track.events.length
        ? h(
            'ul',
            { class: 'timeline' },
            track.events.map((event) =>
              h('li', null, h('span', { class: 'when' }, stamp(event.at)), ' ', event.text),
            ),
          )
        : null,
    );
  };

  const domainRecord = (domain) => {
    const parts = [];
    const campaign = campaignOf(domain);
    const registration = domain.registration || {};
    const scans = domain.scans;
    const page = domain.page;
    const copy = h(
      'button',
      {
        type: 'button',
        class: 'quiet',
        onclick: (event) => copyText(defang(domain.domain), event.currentTarget, 'Copied'),
      },
      'Copy',
    );

    parts.push(
      h(
        'div',
        { class: 'record-block' },
        h(
          'p',
          { class: 'record-kicker' },
          domain.role === 'seed'
            ? 'The link you started from'
            : domain.track
              ? 'Watched site'
              : 'Linked site',
        ),
        h('h3', null, defang(domain.domain)),
        h(
          'div',
          { class: 'score' },
          h('span', { class: 'score-number' }, String(domain.risk.score)),
          h('span', { class: 'score-of' }, 'risk out of 100'),
          levelBadge(domain.risk.level),
          copy,
        ),
        h(
          'p',
          { class: 'record-kicker' },
          [STATES[domain.state] || domain.state, domain.category].filter(Boolean).join(' · '),
        ),
      ),
    );

    if (domain.track) parts.push(trackingBlock(domain.track));

    if (domain.title || campaign) {
      parts.push(
        h(
          'div',
          { class: 'record-block' },
          h('h4', null, 'What it shows'),
          domain.title ? h('p', { class: 'record-title' }, domain.title) : null,
          page && page.description
            ? h('p', { class: 'reason-detail' }, shorten(page.description, 200))
            : null,
          campaign && campaign.size > 1
            ? h(
                'button',
                {
                  type: 'button',
                  class: 'linklike',
                  onclick: () => selectGroup('campaign', campaign.id),
                },
                `Same lure on ${plural(campaign.size - 1, 'other site')}`,
              )
            : null,
          domain.targets.length
            ? h(
                'p',
                { class: 'reason-detail' },
                `Aimed at ${domain.targets.map((target) => `${countryName(target.country)} (${target.why})`).join(', ')}`,
              )
            : null,
        ),
      );
    }

    parts.push(
      h(
        'div',
        { class: 'record-block' },
        h('h4', null, 'Why it scores this way'),
        h(
          'ul',
          { class: 'reasons' },
          domain.risk.signals.map((signal) =>
            h(
              'li',
              null,
              weightTicks(signal.weight),
              h(
                'span',
                null,
                signal.label,
                signal.detail
                  ? h('span', { class: 'reason-detail' }, shorten(signal.detail, 220))
                  : null,
              ),
            ),
          ),
        ),
        domain.risk.mitigations
          ? h(
              'p',
              { class: 'reason-detail' },
              `Counted in its favour: ${domain.risk.mitigations.join('; ')}`,
            )
          : null,
      ),
    );

    if ((domain.findings || []).length) {
      parts.push(
        h(
          'div',
          { class: 'record-block' },
          h('h4', null, 'What its code does'),
          h(
            'ul',
            { class: 'reasons' },
            domain.findings.map((finding) =>
              h(
                'li',
                null,
                weightTicks(finding.severity === 3 ? 0.6 : finding.severity === 2 ? 0.35 : 0.1),
                h(
                  'span',
                  null,
                  finding.label,
                  h(
                    'span',
                    { class: 'reason-detail mono' },
                    `${finding.hidden ? 'Hidden in encoded script: ' : ''}${shorten(finding.evidence, 140)}`,
                  ),
                ),
              ),
            ),
          ),
        ),
      );
    }

    const contacts = (page && page.contacts) || [];
    if (contacts.length) {
      parts.push(
        h(
          'div',
          { class: 'record-block' },
          h('h4', null, 'Contact points on the page'),
          h(
            'ul',
            { class: 'plain-list' },
            contacts
              .slice(0, 8)
              .map((contact) =>
                h('li', null, `${contact.kind}: `, h('span', { class: 'mono' }, contact.id)),
              ),
          ),
          h(
            'p',
            { class: 'reason-detail' },
            'Often hijacked or throwaway accounts. A lead about the scam, not the identity of a person.',
          ),
        ),
      );
    }

    const shared = model.linksOf.get(domain.domain) || [];
    if (shared.length) {
      parts.push(
        h(
          'div',
          { class: 'record-block' },
          h('h4', null, 'Shared with other sites'),
          h(
            'ul',
            { class: 'plain-list' },
            shared
              .slice(0, 10)
              .map((link) =>
                h(
                  'li',
                  null,
                  h(
                    'button',
                    { type: 'button', class: 'linklike', onclick: () => focusLink(link) },
                    `${link.kindLabel}: ${shorten(link.label, 44)}`,
                  ),
                  h(
                    'span',
                    { class: 'reason-detail' },
                    `${plural(link.domains.length - 1, 'other site')} · ${link.strength} link`,
                  ),
                ),
              ),
          ),
        ),
      );
    }

    const addresses = domain.addresses || (domain.dns && domain.dns.a) || [];
    parts.push(
      h(
        'div',
        { class: 'record-block' },
        h('h4', null, 'Registration and hosting'),
        h(
          'dl',
          { class: 'facts' },
          fact(
            'Registered',
            domain.created
              ? `${day(domain.created)}${domain.createdIsEstimate ? ' (estimated from scans)' : ''}`
              : null,
          ),
          fact('Registrar', registration.registrar),
          fact(
            'Report abuse to',
            registration.abuseEmail ? h('span', { class: 'mono' }, registration.abuseEmail) : null,
          ),
          fact(
            'Nameservers',
            domain.nameservers ? h('span', { class: 'mono' }, domain.nameservers.key) : null,
          ),
          fact('Hosting', hostingOf(domain)),
          fact(
            'Addresses',
            addresses.length ? h('span', { class: 'mono' }, addresses.join(', ')) : null,
          ),
          fact(
            'Blocklists',
            domain.blocklists.length ? domain.blocklists.map((hit) => hit.name).join(', ') : null,
          ),
        ),
      ),
    );

    if (scans || domain.urls.length) {
      parts.push(
        h(
          'div',
          { class: 'record-block' },
          h('h4', null, 'Evidence'),
          h(
            'dl',
            { class: 'facts' },
            fact(
              'Seen in scans',
              scans
                ? `${plural(scans.count, 'scan')}, ${day(scans.first)} to ${day(scans.last)}`
                : null,
            ),
            fact(
              'Scan reports',
              scans && scans.reports.length
                ? h(
                    'span',
                    null,
                    scans.reports.map((url, index) => [
                      index ? ', ' : '',
                      h(
                        'a',
                        { href: url, target: '_blank', rel: 'noopener noreferrer' },
                        `urlscan.io report ${index + 1}`,
                      ),
                    ]),
                  )
                : null,
            ),
            fact(
              'Example link',
              domain.urls[0]
                ? h('span', { class: 'mono' }, shorten(defang(domain.urls[0]), 160))
                : null,
            ),
            fact(
              'Checked live',
              domain.live
                ? domain.live.ok
                  ? `Answered with HTTP ${domain.live.status}`
                  : `No answer: ${shorten(domain.live.error, 80)}`
                : null,
            ),
            fact(
              'Front page',
              domain.root && domain.root.sample
                ? h('span', { class: 'mono' }, shorten(domain.root.sample, 60))
                : null,
            ),
          ),
        ),
      );
    }

    parts.push(
      h(
        'div',
        { class: 'record-block' },
        h('h4', null, 'Report it'),
        h(
          'ul',
          { class: 'plain-list' },
          h(
            'li',
            null,
            h(
              'a',
              {
                href: 'https://safebrowsing.google.com/safebrowsing/report_phish/',
                target: '_blank',
                rel: 'noopener noreferrer',
              },
              'Google Safe Browsing',
            ),
            ' gets it blocked in Chrome, Safari and Firefox',
          ),
          hostingOf(domain) === 'Cloudflare'
            ? h(
                'li',
                null,
                h(
                  'a',
                  {
                    href: 'https://abuse.cloudflare.com/',
                    target: '_blank',
                    rel: 'noopener noreferrer',
                  },
                  'Cloudflare abuse form',
                ),
                ', since Cloudflare fronts this site',
              )
            : null,
          registration.abuseEmail
            ? h(
                'li',
                null,
                'The registrar, at ',
                h('span', { class: 'mono' }, registration.abuseEmail),
              )
            : null,
        ),
      ),
    );
    return parts;
  };

  const groupRecord = (group) => {
    const members = group.members.slice().sort((a, b) => b.risk.score - a.risk.score);
    const campaign =
      ui.groupBy === 'campaign' || group.dimension === 'campaign'
        ? model.campaigns.get(group.key)
        : null;
    const counts = LEVELS.map((level) => [
      level,
      members.filter((domain) => domain.risk.level === level.id).length,
    ]).filter(([, count]) => count);
    return [
      h(
        'div',
        { class: 'record-block' },
        h(
          'p',
          { class: 'record-kicker' },
          `${DIMENSIONS[group.dimension || ui.groupBy].label} · ${plural(members.length, 'site')}`,
        ),
        h('h3', { class: 'plain' }, group.label),
        h(
          'p',
          null,
          counts.map(([level, count], index) => [
            index ? ' · ' : '',
            levelBadge(level.id, `${count} ${level.label.toLowerCase()}`),
          ]),
        ),
      ),
      campaign
        ? h(
            'div',
            { class: 'record-block' },
            h('h4', null, 'Campaign'),
            h(
              'dl',
              { class: 'facts' },
              fact('Name used', campaign.brand),
              fact('Aimed at', campaign.targets.map(countryName).join(', ')),
              fact(
                'Seen',
                campaign.firstSeen
                  ? `${day(campaign.firstSeen)} to ${day(campaign.lastSeen)}`
                  : null,
              ),
              fact('Confirmed live', campaign.live ? plural(campaign.live, 'site') : null),
              fact('Kit', campaign.kit),
            ),
          )
        : null,
      h(
        'div',
        { class: 'record-block' },
        h('h4', null, 'Sites'),
        h(
          'ul',
          { class: 'member-list' },
          members
            .slice(0, 80)
            .map((domain) =>
              h(
                'li',
                null,
                h(
                  'button',
                  { type: 'button', class: 'linklike mono', onclick: () => selectDomain(domain) },
                  defang(domain.domain),
                ),
              ),
            ),
        ),
        members.length > 80
          ? h(
              'p',
              { class: 'reason-detail' },
              `and ${members.length - 80} more, listed in the table below`,
            )
          : null,
      ),
    ];
  };

  const overviewRecord = () => {
    const summary = model.data.summary;
    const recent = model.data.recent || [];
    return [
      h(
        'div',
        { class: 'record-block' },
        h('p', { class: 'record-kicker' }, 'Overview'),
        h('h3', { class: 'plain' }, model.rootLabel),
        h('p', null, summary.headline),
      ),
      h(
        'div',
        { class: 'record-block' },
        h(
          'p',
          { class: 'reason-detail' },
          'Select a point on the map, or a row in the tables below, to see the evidence for that site.',
        ),
      ),
      recent.length
        ? h(
            'div',
            { class: 'record-block' },
            h('h4', null, 'Latest activity'),
            h(
              'ul',
              { class: 'timeline' },
              recent.slice(0, 14).map((event) =>
                h(
                  'li',
                  null,
                  h('span', { class: 'when' }, stamp(event.at)),
                  ' ',
                  model.byName.has(event.domain)
                    ? h(
                        'button',
                        {
                          type: 'button',
                          class: 'linklike mono',
                          onclick: () => selectDomain(model.byName.get(event.domain)),
                        },
                        defang(event.domain),
                      )
                    : h('span', { class: 'mono' }, defang(event.domain)),
                  ` ${event.text}`,
                ),
              ),
            ),
          )
        : null,
    ];
  };

  const renderRecord = () => {
    const record = byId('record');
    let content;
    if (ui.selected && ui.selected.type === 'domain') content = domainRecord(ui.selected.domain);
    else if (ui.selected && ui.selected.type === 'group') content = groupRecord(ui.selected);
    else content = overviewRecord();
    record.replaceChildren(...content.filter(Boolean));
    record.scrollTop = 0;
  };

  const selectGroup = (dimension, key) => {
    const members = model.domains.filter((domain) => DIMENSIONS[dimension].of(domain)[0] === key);
    if (!members.length) return;
    ui.selected = {
      type: 'group',
      key,
      dimension,
      label: DIMENSIONS[dimension].of(members[0])[1],
      members,
    };
    ui.focusLink = null;
    refreshPanels();
    requestDraw();
  };

  const focusLink = (link) => {
    ui.focusLink = ui.focusLink === link ? null : link;
    refreshPanels();
    requestDraw();
  };

  const renderFocusNote = () => {
    const note = byId('focus-note');
    note.replaceChildren();
    note.hidden = !ui.focusLink;
    if (!ui.focusLink) return;
    note.append(
      h(
        'span',
        null,
        `Showing the ${plural(ui.focusLink.domains.length, 'site')} with: ${ui.focusLink.kindLabel.toLowerCase()} `,
        h('span', { class: 'mono' }, shorten(ui.focusLink.label, 60)),
      ),
      h('button', { type: 'button', onclick: () => focusLink(ui.focusLink) }, 'Clear'),
    );
  };

  const renderStats = () => {
    const summary = model.data.summary;
    const seed = model.seed;
    const tiles = [];
    const radar = model.data.radar;
    if (radar) {
      const count = (value) => Number(value || 0).toLocaleString('en');
      tiles.push([
        'Domains indexed',
        count(radar.indexed.domains),
        `${count(radar.indexed.blocklisted)} on blocklists`,
      ]);
      tiles.push([
        'Suspect sites watched',
        count(radar.watched.sites),
        `${count(radar.watched.visited)} visited so far`,
      ]);
      tiles.push([
        'Up right now',
        count(radar.watched.live),
        `${count(radar.watched.runningAKnownKit)} run a known kit`,
      ]);
      tiles.push(['Taken down', count(radar.watched.takenDown), 'while being watched']);
      tiles.push([
        'New registrations in batches',
        count(radar.indexed.inBulkBatches),
        `${radar.batches.length}+ moulds flagged`,
      ]);
    }
    if (seed)
      tiles.push(['Risk of this link', `${seed.risk.score}/100`, levelBadge(seed.risk.level)]);
    if (!radar)
      tiles.push([
        seed ? 'Linked sites' : 'Leads collected',
        String(summary.related),
        summary.firstSeen ? `first seen ${day(summary.firstSeen)}` : 'in the sources searched',
      ]);
    if (!radar)
      tiles.push([
        'High or critical',
        String(summary.levels.critical + summary.levels.high),
        `of ${summary.domains} scored`,
      ]);
    if (!radar) tiles.push(['Campaigns', String(summary.campaigns), 'distinct lures']);
    tiles.push([
      'Countries targeted',
      String(summary.targets.length),
      summary.targets
        .slice(0, 3)
        .map((target) => countryName(target.country))
        .join(', ') || 'none identified',
    ]);
    if (!radar) tiles.push(['Confirmed live', String(summary.live), `${summary.offline} offline`]);
    byId('stats').replaceChildren(
      ...tiles.map(([label, value, note]) =>
        h(
          'div',
          { class: 'stat' },
          h('span', { class: 'stat-label' }, label),
          h('span', { class: 'stat-value' }, value),
          h('span', { class: 'stat-note' }, note),
        ),
      ),
    );
  };

  const renderChips = () => {
    byId('level-chips').replaceChildren(
      ...LEVELS.map((level) => {
        const count = model.domains.filter((domain) => domain.risk.level === level.id).length;
        return h(
          'button',
          {
            type: 'button',
            class: 'chip',
            'aria-pressed': String(ui.levels.has(level.id)),
            onclick: () => {
              if (ui.levels.has(level.id)) ui.levels.delete(level.id);
              else ui.levels.add(level.id);
              relayout();
            },
          },
          mark(level.id),
          level.label,
          h('span', { class: 'chip-count' }, String(count)),
        );
      }),
    );
  };

  const renderLegend = () => {
    const network = ui.view === 'network';
    byId('legend').replaceChildren(
      ...LEVELS.map((level) =>
        h('span', { class: 'legend-item' }, mark(level.id), `${level.label} risk`),
      ),
      h('span', { class: 'legend-item' }, mark('low', true), 'Hollow: offline'),
      h(
        'span',
        { class: 'legend-item' },
        network
          ? '○ campaign   • shared detail'
          : `○ ${DIMENSIONS[ui.groupBy].label.toLowerCase()}`,
      ),
      h(
        'span',
        { class: 'legend-item legend-hint' },
        ui.view === 'globe'
          ? 'Drag to turn · pinch or Ctrl + scroll to zoom'
          : 'Drag to move · pinch or Ctrl + scroll to zoom',
      ),
    );
  };

  const renderCampaigns = () => {
    const section = byId('campaigns-section');
    const campaigns = model.data.campaigns;
    section.hidden = !campaigns.length;
    if (!campaigns.length) return;
    const head = h(
      'thead',
      null,
      h(
        'tr',
        null,
        ['Lure', 'Name used', 'Aimed at'].map((text) => h('th', { scope: 'col' }, text)),
        ['Sites', 'Live'].map((text) => h('th', { scope: 'col', class: 'num' }, text)),
        h('th', { scope: 'col' }, 'Last seen'),
      ),
    );
    const more = byId('campaigns-more');
    more.hidden = campaigns.length <= ui.campaignsShown;
    more.textContent = `Show all ${campaigns.length} campaigns`;
    const body = h(
      'tbody',
      null,
      campaigns.slice(0, ui.campaignsShown).map((campaign) =>
        h(
          'tr',
          {
            class: `selectable${ui.selected && ui.selected.type === 'group' && ui.selected.key === campaign.id ? ' current' : ''}`,
            tabindex: '0',
            onclick: () => selectGroup('campaign', campaign.id),
            onkeydown: (event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                selectGroup('campaign', campaign.id);
              }
            },
          },
          h('td', { class: 'lure' }, campaign.label),
          h('td', null, campaign.brand || '—'),
          h('td', null, campaign.targets.map(countryName).join(', ') || '—'),
          h('td', { class: 'num' }, String(campaign.size)),
          h('td', { class: 'num' }, String(campaign.live)),
          h('td', null, day(campaign.lastSeen)),
        ),
      ),
    );
    byId('campaigns').replaceChildren(head, body);
  };

  const COLUMNS = [
    { key: 'score', label: 'Risk', value: (domain) => domain.risk.score, numeric: true },
    { key: 'domain', label: 'Site', value: (domain) => domain.domain },
    { key: 'state', label: 'State', value: (domain) => domain.state },
    { key: 'title', label: 'Lure', value: (domain) => stripEmoji(domain.title || '') },
    {
      key: 'target',
      label: 'Aimed at',
      value: (domain) => (domain.targets[0] ? countryName(domain.targets[0].country) : ''),
    },
    { key: 'created', label: 'Registered', value: (domain) => domain.created || '' },
    {
      key: 'seen',
      label: 'Last seen',
      value: (domain) => (domain.scans && domain.scans.last) || '',
    },
  ];

  const sortedDomains = () => {
    const column = COLUMNS.find((item) => item.key === ui.sort.key) || COLUMNS[0];
    const rows = (
      ui.focusLink
        ? visibleDomains().filter((domain) => ui.focusLink.domains.includes(domain.domain))
        : visibleDomains()
    ).slice();
    rows.sort((a, b) => {
      const left = column.value(a);
      const right = column.value(b);
      const order = column.numeric ? left - right : String(left).localeCompare(String(right));
      return order * ui.sort.dir || b.risk.score - a.risk.score || a.domain.localeCompare(b.domain);
    });
    return rows;
  };

  const renderDomains = () => {
    const rows = sortedDomains();
    const head = h(
      'thead',
      null,
      h(
        'tr',
        null,
        COLUMNS.map((column) =>
          h(
            'th',
            {
              scope: 'col',
              class: column.numeric ? 'num' : '',
              'aria-sort':
                ui.sort.key === column.key
                  ? ui.sort.dir > 0
                    ? 'ascending'
                    : 'descending'
                  : 'none',
            },
            h(
              'button',
              {
                type: 'button',
                onclick: () => {
                  ui.sort = {
                    key: column.key,
                    dir: ui.sort.key === column.key ? -ui.sort.dir : column.numeric ? -1 : 1,
                  };
                  renderDomains();
                },
              },
              column.label,
            ),
          ),
        ),
      ),
    );
    const body = h(
      'tbody',
      null,
      rows.slice(0, ui.rowsShown).map((domain) =>
        h(
          'tr',
          {
            class: `selectable${ui.selected && ui.selected.type === 'domain' && ui.selected.domain === domain ? ' current' : ''}`,
            tabindex: '0',
            onclick: () => selectDomain(domain, true),
            onkeydown: (event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                selectDomain(domain, true);
              }
            },
          },
          h('td', { class: 'num' }, levelBadge(domain.risk.level, String(domain.risk.score))),
          h('td', null, h('span', { class: 'mono' }, defang(domain.domain))),
          h(
            'td',
            null,
            {
              live: 'Live',
              resolves: 'Resolves',
              offline: 'Offline',
              unreachable: 'Not serving',
              unknown: 'Unchecked',
            }[domain.state] || domain.state,
          ),
          h('td', { class: 'lure' }, shorten(domain.title || '—', 90)),
          h(
            'td',
            null,
            domain.targets.map((target) => countryName(target.country)).join(', ') || '—',
          ),
          h('td', null, day(domain.created)),
          h('td', null, day(domain.scans && domain.scans.last)),
        ),
      ),
    );
    byId('domains').replaceChildren(head, body);
    byId('domains-count').textContent =
      rows.length === model.domains.length
        ? `${plural(rows.length, 'site')}, highest risk first`
        : `${rows.length} of ${plural(model.domains.length, 'site')} match the filters`;
    const more = byId('domains-more');
    more.hidden = rows.length <= ui.rowsShown;
    more.textContent = `Show all ${rows.length} sites`;
  };

  const renderLinks = () => {
    const section = byId('links-section');
    section.hidden = !model.links.length;
    byId('links').replaceChildren(
      ...model.links.slice(0, 60).map((link) =>
        h(
          'li',
          null,
          h(
            'button',
            {
              type: 'button',
              'aria-pressed': String(ui.focusLink === link),
              onclick: () => focusLink(link),
            },
            h('span', { class: 'link-kind' }, link.kindLabel),
            h('span', { class: 'link-value' }, shorten(link.label, 70)),
            h(
              'span',
              { class: 'link-count' },
              `${plural(link.domains.length, 'site')} · ${link.strength} link`,
            ),
          ),
        ),
      ),
    );
  };

  const renderMethod = () => {
    const data = model.data;
    const sources = data.sources || {};
    const parts = [];
    const feedCount = sources.feeds ? Object.keys(sources.feeds.loaded).length : 0;
    parts.push(
      h(
        'p',
        null,
        `Built from public sources: the urlscan.io scan archive${sources.urlscanWindowDays ? ` (last ${sources.urlscanWindowDays} days)` : ''}, DNS, domain registration records, certificate logs${feedCount ? ` and ${plural(feedCount, 'scam blocklist')}` : ''}. `,
        'Sites were only ever read, never interacted with.',
      ),
      h(
        'p',
        null,
        'A risk score is an estimate that ranks what to look at first. It adds up the evidence listed for each site and is not proof of wrongdoing. A site that was merely found by a search still has to earn its score on its own evidence. Addresses are written with [.] so they cannot be opened by accident.',
      ),
    );
    if ((data.pivots || []).length) {
      parts.push(
        h('p', null, 'Searches run:'),
        h(
          'ul',
          null,
          data.pivots.map((pivot) =>
            h(
              'li',
              null,
              `${pivot.why || pivot.type}: `,
              h('span', { class: 'mono' }, shorten(pivot.value, 70)),
              pivot.status === 'too-common'
                ? ` — ${pivot.total} matches, too common to mean anything, ignored`
                : pivot.status === 'skipped'
                  ? ' — skipped, out of time'
                  : ` — ${pivot.total || 0} matches`,
            ),
          ),
        ),
      );
    }
    if ((sources.errors || []).length) {
      parts.push(
        h('p', null, 'Sources that had problems, so may be under-represented:'),
        h(
          'ul',
          null,
          sources.errors.map((error) => h('li', null, `${error.source}: ${error.message}`)),
        ),
      );
    }
    if (data.partial)
      parts.push(
        h('p', null, 'This run stopped at a time or size limit, so the picture is partial.'),
      );
    byId('method').replaceChildren(...parts);
  };

  const refreshPanels = () => {
    renderRecord();
    renderFocusNote();
    renderCampaigns();
    renderDomains();
    renderLinks();
  };

  const relayout = (keepCamera) => {
    layout();
    if (!keepCamera) fit();
    renderChips();
    renderLegend();
    refreshPanels();
    requestDraw();
  };

  // ---------------------------------------------------------------- controls

  const VIEWS = ['globe', 'tree', 'network'];
  const setView = (name) => {
    ui.view = name;
    for (const id of VIEWS) byId(`view-${id}`).setAttribute('aria-pressed', String(id === name));
    byId('group-field').hidden = name === 'network';
    spinButton.hidden = name !== 'globe';
    relayout();
    startSpin();
  };
  for (const id of VIEWS) byId(`view-${id}`).addEventListener('click', () => setView(id));
  byId('group-by').addEventListener('change', (event) => {
    ui.groupBy = event.target.value;
    if (ui.selected && ui.selected.type === 'group') ui.selected = null;
    relayout();
  });
  byId('search').addEventListener('input', (event) => {
    ui.query = event.target.value.trim().toLowerCase();
    relayout();
  });
  byId('campaigns-more').addEventListener('click', () => {
    ui.campaignsShown = Infinity;
    renderCampaigns();
  });
  byId('domains-more').addEventListener('click', () => {
    ui.rowsShown = Infinity;
    renderDomains();
  });
  byId('copy-domains').addEventListener('click', (event) => {
    const rows = sortedDomains();
    copyText(
      rows.map((domain) => defang(domain.domain)).join('\n'),
      event.currentTarget,
      `Copied ${rows.length}`,
    );
  });

  // ---------------------------------------------------------------- loading

  // Draw a result. `keep` is for live refreshes: the view, filters, camera and selection stay put
  const show = (data, keep) => {
    const selectedName =
      keep && ui.selected && ui.selected.type === 'domain' ? ui.selected.domain.domain : null;
    model.data = data;
    model.domains = (data.domains || []).filter((domain) => !(domain.risk && domain.risk.benign));
    model.byName = new Map(model.domains.map((domain) => [domain.domain, domain]));
    model.campaigns = new Map((data.campaigns || []).map((campaign) => [campaign.id, campaign]));
    model.links = data.links || [];
    model.linksOf = new Map();
    for (const link of model.links) {
      for (const name of link.domains) {
        if (!model.linksOf.has(name)) model.linksOf.set(name, []);
        model.linksOf.get(name).push(link);
      }
    }
    model.seed = model.domains.find((domain) => domain.role === 'seed') || null;
    model.rootLabel = data.seed
      ? data.seed.domain
      : data.kind === 'radar'
        ? 'Radar'
        : ((data.hunt && data.hunt.profiles) || []).map((profile) => profile.name).join(' + ') ||
          'Hunt results';

    const target = byId('target');
    target.textContent = data.seed ? defang(data.seed.domain) : model.rootLabel;
    target.classList.toggle('plain', !data.seed);
    const link = byId('target-link');
    link.hidden = !data.seed || data.seed.url.replace(/\/$/, '') === `https://${data.seed.domain}`;
    link.textContent = data.seed ? shorten(defang(data.seed.url), 150) : '';
    byId('headline').textContent = data.summary.headline;
    byId('stamp').textContent = `${keep ? 'Live · updated' : 'Generated'} ${String(data.generatedAt)
      .slice(0, keep ? 19 : 16)
      .replace('T', ' ')} UTC`;
    byId('map').setAttribute(
      'aria-label',
      `Map of ${model.domains.length} linked sites. The same sites are listed in the table below.`,
    );

    const select = byId('group-by');
    select.replaceChildren(
      ...Object.entries(DIMENSIONS).map(([key, dimension]) =>
        h('option', { value: key }, dimension.label),
      ),
    );
    if (!keep && !model.campaigns.size) ui.groupBy = model.seed ? 'found' : 'level';
    select.value = ui.groupBy;

    const again = selectedName && model.byName.get(selectedName);
    ui.selected = again
      ? { type: 'domain', domain: again }
      : model.seed
        ? { type: 'domain', domain: model.seed }
        : null;
    ui.focusLink = null;
    byId('results').hidden = false;
    readColors();
    resize();
    renderStats();
    renderMethod();
    relayout(keep);
    spinButton.hidden = ui.view !== 'globe';
    startSpin();
  };

  const embedded = () => {
    try {
      return JSON.parse(byId('scam-data').textContent);
    } catch {
      return null;
    }
  };

  // The hosted page has no data built in, so it asks the API that ships alongside it
  const startLookup = () => {
    const form = byId('lookup');
    const status = byId('lookup-status');
    const button = byId('lookup-go');
    const params = new URLSearchParams(location.search);
    const endpoint = params.get('api') || '/api/scam-finder';
    form.hidden = false;
    const run = async (target) => {
      button.disabled = true;
      status.className = 'hint';
      status.textContent = 'Investigating. This usually takes 20 to 40 seconds.';
      try {
        const response = await fetch(`${endpoint}?url=${encodeURIComponent(target)}`);
        const data = await response.json();
        if (!data || data.error || !data.domains)
          throw new Error(
            (data && (data.error || data.skipped)) || 'The server sent back nothing usable',
          );
        status.textContent = '';
        show(data);
      } catch (error) {
        status.className = 'hint error';
        status.textContent = `Could not investigate that: ${error.message}. Check the address and try again.`;
      }
      button.disabled = false;
    };
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const target = byId('lookup-input').value.trim();
      if (target) run(target);
    });
    // The live radar: the scanner's watchlist, redrawn every minute while the page is open
    const radarEndpoint = params.get('radar-api') || '/api/scam-radar';
    let polling = 0;
    const loadRadar = async (keep) => {
      try {
        const response = await fetch(`${radarEndpoint}?view=map`);
        const data = await response.json();
        if (!data || !data.domains)
          throw new Error((data && (data.error || data.skipped)) || 'No radar data came back');
        status.textContent = '';
        show(data, keep);
        return true;
      } catch (error) {
        if (!keep) {
          status.className = 'hint error';
          status.textContent = `The live radar is not available: ${error.message}`;
        }
        return false;
      }
    };
    const openRadar = async () => {
      status.className = 'hint';
      status.textContent = 'Opening the live radar.';
      if (!(await loadRadar(false)) || polling) return;
      polling = setInterval(() => {
        if (!document.hidden) loadRadar(true);
      }, 60000);
    };
    byId('lookup-radar').addEventListener('click', openRadar);

    const preset = params.get('url');
    if (preset) {
      byId('lookup-input').value = preset;
      run(preset);
    } else if (params.has('radar')) {
      openRadar();
    }
  };

  if (typeof ResizeObserver === 'function') {
    new ResizeObserver(() => {
      if (!model.data) return;
      resize();
      fit();
      requestDraw();
    }).observe(canvas);
  }
  const themeChanged = () => {
    if (!model.data) return;
    readColors();
    requestDraw();
  };
  if (window.matchMedia)
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', themeChanged);
  new MutationObserver(themeChanged).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['data-theme'],
  });

  const data = embedded();
  if (data && data.domains) show(data);
  else startLookup();
})();
