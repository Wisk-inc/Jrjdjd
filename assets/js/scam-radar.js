/* Scam Radar: draws what the scanner publishes, and checks a single site on request.
   - Data: the newest of the published snapshot (scam-radar-data branch) and the copy on this site.
     Whichever answers first is drawn at once. A tiny status file is polled every 15 seconds after that,
     and when a new snapshot lands (about once a minute while the scanner runs) what changed is shown:
     numbers roll to their new values, new cycles join the chart and new events are marked.
   - The console says what the scanner is doing from what it published: scanning, moving to a fresh
     run, waiting or paused. Nothing on the page moves unless the data did.
   - "Your country" is guessed from the device's time zone, on the device. Nothing is sent anywhere.
   - "Check a site" has three parts: the address judged by Scam Finder's own rules in the browser
     (scam-finder-core.js), Radar's record for the site (looked up by a hash of its name), and, where
     this host runs the API, a deep dive: a visit, the registration, DNS and mail, certificate logs,
     earlier scans and the sites linked to it.
   - A pasted email address, phone number, Telegram account or wallet is checked instead against the
     contacts Radar saw on named scam pages (by a hash, so what was typed is not sent) and, for email
     and phone, against what Scam Finder's contact check says about it. No one is looked up anywhere.
   Every value from the data goes in through textContent, never as HTML. No checked site is ever linked. */
(() => {
  'use strict';
  const RAW = 'https://raw.githubusercontent.com/Wisk-inc/Jrjdjd/';
  const DATA = `${RAW}scam-radar-data/`;
  // Where the data branch points right now (see api/scam-radar-status.js). Read by name, the branch
  // can lag a push by a few minutes; read by commit, a file is exactly what was published.
  const STATUS_API = '/api/scam-radar-status';
  const LOCAL = '/assets/data/scam-radar.json';
  const API = '/api/scam-finder';
  const REFRESH_MS = 15 * 1000;
  const HANDOVER_S = 150; // a fresh run's first update lands about two and a half minutes after the hand-over
  const SLOTS = 60;       // minutes in the chart
  const NAMED_STEP = 25;

  const $ = (sel) => document.querySelector(sel);
  const el = (tag, text, cls) => {
    const node = document.createElement(tag);
    if (text !== undefined && text !== null) node.textContent = String(text);
    if (cls) node.className = cls;
    return node;
  };
  const num = (n) => (typeof n === 'number' ? n.toLocaleString('en') : '0');
  const plural = (n, one, many) => `${num(n)} ${n === 1 ? one : many || `${one}s`}`;
  const isCC = (cc) => /^[A-Z]{2}$/.test(cc || '');
  const regionNames = (() => { try { return new Intl.DisplayNames(['en'], { type: 'region' }); } catch { return null; } })();
  const countryName = (cc) => {
    if (!isCC(cc)) return 'Unknown';
    try { return (regionNames && regionNames.of(cc)) || cc; } catch { return cc; }
  };
  // Country names inside a sentence: "aimed at the Philippines", "aimed at Jamaica"
  const THE = new Set(['AE', 'BS', 'CF', 'CK', 'DO', 'FK', 'FO', 'GB', 'GM', 'KM', 'KY', 'MH', 'MP', 'MV', 'NL', 'PH',
    'SB', 'TC', 'UM', 'US', 'VG', 'VI']);
  const inSentence = (cc) => `${THE.has(cc) ? 'the ' : ''}${countryName(cc)}`;
  const flag = (cc) => (isCC(cc) ? String.fromCodePoint(...[...cc].map((c) => 0x1f1a5 + c.charCodeAt(0))) : '');
  const label = (cc) => `${flag(cc)} ${countryName(cc)}`.trim();
  const since = (iso) => {
    const t = Date.parse(iso);
    if (!t) return '';
    let s = Math.max(0, Math.floor((Date.now() - t) / 1000));
    const h = Math.floor(s / 3600); s -= h * 3600;
    const m = Math.floor(s / 60); s -= m * 60;
    if (h >= 48) return `${Math.round(h / 24)} days ago`;
    if (h) return `${h} h ${m} min ago`;
    if (m) return `${m} min ${s} s ago`;
    return `${s} s ago`;
  };
  const ago = (iso) => { // coarser, for lists
    const t = Date.parse(iso);
    if (!t) return '';
    const s = Math.max(0, Math.round((Date.now() - t) / 1000));
    if (s < 60) return `${s} s ago`;
    const m = Math.round(s / 60);
    if (m < 60) return `${m} min ago`;
    if (m < 48 * 60) return `${Math.round(m / 60)} h ago`;
    return `${Math.round(m / 1440)} days ago`;
  };
  const day = (iso) => {
    const t = Date.parse(iso);
    return t ? new Date(t).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) : '';
  };
  const dayYear = (iso) => {
    const t = Date.parse(iso);
    return t ? new Date(t).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '';
  };
  const store = {
    get(key) { try { return window.localStorage.getItem(key); } catch { return null; } },
    set(key, value) { try { window.localStorage.setItem(key, value); } catch { /* private mode */ } },
  };
  const getJson = (url) => fetch(url, { cache: 'no-cache' }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  const minute = () => Math.floor(Date.now() / 60000);
  const clockOf = (ms) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const clock = (iso) => (Date.parse(iso) ? clockOf(Date.parse(iso)) : '');
  const dayTime = (iso) => {
    const t = Date.parse(iso);
    return t ? `${new Date(t).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}, ${clockOf(t)}` : '';
  };
  const span = (seconds) => {
    const s = Math.max(0, Math.round(seconds));
    return s >= 60 ? `${Math.floor(s / 60)} min ${s % 60} s` : `${s} s`;
  };
  const reduceMotion = Boolean(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);

  let data = null;
  let chartEnd = null; // the minute the chart was last drawn to
  let commit = null;   // the data branch's commit the page last read
  let statusApi = true;
  let apiMisses = 0;
  let home = null; // the visitor's country
  let viewChosen = false; // has the visitor picked a map view themselves?
  let namedShown = NAMED_STEP;

  // ---------------------------------------------------------------- the visitor's country
  const guessCountry = async () => {
    const saved = store.get('scam-radar-country');
    if (isCC(saved)) return saved;
    try {
      const zones = await fetch('/assets/data/timezones.json').then((r) => r.json());
      const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
      if (zone && isCC(zones[zone])) return zones[zone];
    } catch { /* fall through to the language */ }
    for (const lang of navigator.languages || [navigator.language]) {
      const region = String(lang || '').split('-')[1];
      if (region && isCC(region.toUpperCase())) return region.toUpperCase();
    }
    return null;
  };

  const fillPicker = () => {
    const picker = $('#sr-country');
    const listed = new Set([...Object.keys(data.byCountry || {}), ...(data.hosts || []).map((r) => r.country)]);
    if (home) listed.add(home);
    const options = [...listed].filter(isCC).sort((a, b) => countryName(a).localeCompare(countryName(b)));
    const current = picker.value || home || '';
    picker.replaceChildren(el('option', 'Choose a country'));
    picker.firstChild.value = '';
    options.forEach((cc) => {
      const option = el('option', `${label(cc)}${data.byCountry?.[cc] ? ` (${data.byCountry[cc].live})` : ''}`);
      option.value = cc;
      picker.append(option);
    });
    picker.value = current;
  };

  // One named site as a list row. Clicking it runs the checker on that site.
  const siteRow = (r) => {
    const li = el('li');
    const name = el('button', r.domain, 'sr-domain sr-site');
    name.type = 'button';
    name.dataset.check = r.domain;
    li.append(name);
    const why = [
      r.title && `shows “${r.title}”`,
      r.impersonates?.[0] && `pretends to be ${r.impersonates[0]}`,
      r.kit && `scam kit: ${r.kit}`,
      ...(r.listedBy || []).slice(0, 1).map((l) => `on a ${l}`),
    ].filter(Boolean);
    li.append(el('span', why.length ? ` ${why.slice(0, 3).join('; ')}` : ''));
    return li;
  };

  const drawHome = () => {
    const cc = $('#sr-country').value || home;
    const title = $('#sr-home-title');
    const body = $('#sr-home-body');
    body.replaceChildren();
    const named = data.named || [];
    const worst = (rows) => {
      const list = el('ul', null, 'sr-downs');
      rows.forEach((r) => list.append(siteRow(r)));
      return list;
    };
    if (!isCC(cc)) {
      title.textContent = 'Scams aimed at your country';
      body.append(el('p', 'Choose your country to see the scams aimed at it. Until then, these are the live sites with the highest scores anywhere:', 'sr-note'));
      body.append(worst(named.slice(0, 6)));
      return;
    }
    const entry = (data.byCountry || {})[cc];
    const hosted = ((data.hosts || []).find((r) => r.country === cc) || {}).live || 0;
    title.textContent = `Scams aimed at ${inSentence(cc)}`;
    const top = el('p', null, 'sr-home-count');
    top.append(el('strong', num(entry ? entry.live : 0)),
      el('span', ` live scam site${entry && entry.live === 1 ? '' : 's'} aimed at ${inSentence(cc)} right now`));
    body.append(top);
    if (hosted) body.append(el('p', `${plural(hosted, 'live scam site')} ${hosted === 1 ? 'is' : 'are'} hosted in ${inSentence(cc)}.`, 'sr-note'));
    if (entry && (entry.brands || []).length) {
      body.append(el('p', 'Brands they pretend to be:', 'sr-home-label'));
      const list = el('ul', null, 'sr-chips');
      entry.brands.forEach((b) => list.append(el('li', `${b.name} · ${b.live}`)));
      body.append(list);
    }
    const mine = named.filter((r) => (r.targets || []).includes(cc)).slice(0, 10);
    if (mine.length) {
      body.append(el('p', 'Named on strong evidence (don’t visit these):', 'sr-home-label'));
      body.append(worst(mine));
    } else {
      // Nothing aimed here by name: say so, then show what a visitor from here is most likely to meet
      body.append(el('p', `No named scam site is aimed at ${inSentence(cc)} by brand, currency or language right now. Most scams are aimed at nobody in particular and reach people by message, so these are the live sites with the highest scores anywhere:`, 'sr-note'));
      body.append(worst(named.slice(0, 6)));
    }
  };

  // ---------------------------------------------------------------- map and country table
  const currentView = () => document.querySelector('input[name="sr-view"]:checked')?.value || 'targets';
  const shadeMap = (view) => {
    const rows = data[view] || [];
    const counts = new Map(rows.map((r) => [r.country, r.live]));
    const max = Math.max(1, ...rows.map((r) => r.live));
    document.querySelectorAll('.sr-map path').forEach((p) => {
      const title = p.querySelector('title');
      if (title && !p.dataset.name) p.dataset.name = title.textContent.split(':')[0];
      const n = counts.get(p.dataset.cc) || 0;
      const level = n ? Math.min(5, 1 + Math.floor((4 * Math.log(n + 1)) / Math.log(max + 1))) : 0;
      p.setAttribute('data-level', String(level));
      if (p.dataset.cc === home) p.setAttribute('data-home', ''); else p.removeAttribute('data-home');
      if (title) title.textContent = `${p.dataset.name}: ${n} live scam site${n === 1 ? '' : 's'}`;
    });
    $('#sr-map-title-text').textContent = view === 'hosts' ? 'Where the scams are hosted' : 'Where the scams are aimed';
    $('#sr-map-note').textContent = view === 'hosts'
      ? 'Shaded by where the live scam sites are hosted. Sites behind shared networks such as Cloudflare are left out, because their real server is hidden. Your country has an outline.'
      : 'Shaded by how many live, high-risk scam sites are aimed at each country: by the brand they impersonate, the currency or flag in their title, or their language. Most scam sites aim at nobody in particular, so this count is smaller than the hosting one. Your country has an outline.';
    const body = $('#sr-countries tbody');
    body.replaceChildren();
    if (!rows.length) {
      const tr = el('tr'); const td = el('td', 'None in the latest scan.'); td.colSpan = 3; tr.append(td); body.append(tr);
      return;
    }
    rows.slice(0, 25).forEach((r) => {
      const tr = el('tr', null, r.country === home ? 'is-home' : '');
      tr.append(el('td', label(r.country)), el('td', num(r.live)));
      const bar = el('td'); const meter = el('span', null, 'sr-bar');
      meter.style.setProperty('--w', `${Math.round((100 * r.live) / max)}%`); bar.append(meter); tr.append(bar);
      body.append(tr);
    });
  };
  // Open on whichever view has more to show, unless the visitor has already chosen
  const pickView = () => {
    if (viewChosen) return;
    const total = (rows) => (rows || []).reduce((sum, r) => sum + r.live, 0);
    const richer = total(data.hosts) > 4 * total(data.targets) ? 'hosts' : 'targets';
    const input = document.querySelector(`input[name="sr-view"][value="${richer}"]`);
    if (input) input.checked = true;
  };

  // ---------------------------------------------------------------- leaderboard
  const drawBoard = () => {
    const boards = data.leaderboards || {};
    const make = (id, rows, name, showCountry) => {
      const list = $(`#${id}`);
      if (!list) return;
      list.replaceChildren();
      if (!rows || !rows.length) { list.append(el('li', 'None among the live sites in the latest scan.', 'sr-empty')); return; }
      const max = Math.max(1, ...rows.map((r) => r.live));
      rows.slice(0, 15).forEach((r, i) => {
        const li = el('li');
        li.append(el('span', String(i + 1), 'sr-rank'));
        const who = el('span', null, 'sr-who');
        who.append(el('b', name(r)));
        if (showCountry && r.country) who.append(el('small', label(r.country)));
        li.append(who, el('span', num(r.live), 'sr-count'));
        const meter = el('span', null, 'sr-bar'); meter.style.setProperty('--w', `${Math.round((100 * r.live) / max)}%`);
        li.append(meter);
        list.append(li);
      });
    };
    make('sr-lb-kinds', boards.kinds, (r) => r.name);
    make('sr-lb-brands', boards.brands, (r) => r.name, true);
    make('sr-lb-kits', boards.kits, (r) => r.name);
    make('sr-lb-networks', boards.networks, (r) => r.name, true);
    make('sr-lb-countries', boards.countries, (r) => label(r.country));
  };

  // ---------------------------------------------------------------- live feed
  const feedKey = (r) => `${r.at}|${r.domain}|${r.type}`;
  const drawFeed = (before) => {
    const list = $('#sr-feed');
    list.replaceChildren();
    list.hidden = false;
    const rows = data.feed || [];
    const had = new Set(((before && before.feed) || []).map(feedKey));
    if (!rows.length) list.append(el('li', 'Nothing has changed on a named site in the last two days.', 'sr-empty'));
    rows.slice(0, 40).forEach((r) => {
      const li = el('li', null, `sr-ev sr-ev-${String(r.type).replace(/[^a-z-]/g, '')}${before && !had.has(feedKey(r)) ? ' is-new' : ''}`);
      const when = el('time', ago(r.at), 'sr-ev-time');
      when.dateTime = r.at; when.dataset.at = r.at;
      const what = el('span', null, 'sr-ev-what');
      what.append(el('b', r.text));
      const name = el('button', r.domain, 'sr-domain sr-site');
      name.type = 'button'; name.dataset.check = r.domain;
      what.append(' ', name);
      const extra = [r.title && `shows “${r.title}”`, r.brand && `pretends to be ${r.brand}`, r.kind,
        (r.targets || []).length ? `aimed at ${(r.targets || []).map(inSentence).join(', ')}` : ''].filter(Boolean);
      if (extra.length) what.append(el('small', ` ${extra.join(', ')}`));
      li.append(when, what);
      list.append(li);
    });
    const hour = (data.activity || {}).hour || {};
    const cycle = data.lastCycle;
    const parts = [];
    if (hour['first-visit']) parts.push(`${plural(hour['first-visit'], 'site')} visited for the first time`);
    if (hour['taken-down']) parts.push(`${plural(hour['taken-down'], 'takedown')} recorded`);
    if (hour.kit) parts.push(`${plural(hour.kit, 'scam kit')} recognised`);
    if (hour.title) parts.push(`${plural(hour.title, 'site')} switched lure`);
    let text = parts.length ? `In the last hour: ${parts.join(', ')}.` : '';
    if (cycle) text += ` The last scan cycle visited ${plural(cycle.visited, 'site')} (${num(cycle.up)} up, ${num(cycle.down)} down) and read ${plural(cycle.newFromCertificates, 'new name')} from certificate logs.`;
    $('#sr-activity').textContent = text.trim();
  };

  // ---------------------------------------------------------------- named sites and takedowns
  const drawNamed = () => {
    const body = $('#sr-named tbody');
    const filter = $('#sr-named-filter').value.trim().toLowerCase();
    body.replaceChildren();
    const all = data.named || [];
    const rows = filter ? all.filter((r) => [r.domain, r.domain.replace(/\[\.\]/g, '.'), r.title, r.kit, r.kind, ...(r.impersonates || []),
      ...(r.listedBy || []), ...(r.targets || []).map(countryName), countryName(r.hostedIn)].join(' ').toLowerCase().includes(filter)) : all;
    const total = typeof data.namedTotal === 'number' ? data.namedTotal : all.length;
    const hacked = (data.totals || {}).hackedLive || 0;
    $('#sr-named-count').textContent = filter
      ? `${plural(rows.length, 'match', 'matches')} among the ${num(all.length)} listed`
      : `${plural(total, 'live site')} ${total === 1 ? 'meets' : 'meet'} the bar${total > all.length ? `; the ${num(all.length)} with the highest scores are listed` : ''}.` +
        `${hacked ? ` ${plural(hacked, 'more live scam page')} ${hacked === 1 ? 'sits' : 'sit'} on real sites that were hacked: counted, not named.` : ''}`;
    if (!rows.length) {
      const tr = el('tr'); const td = el('td', filter ? 'No named site matches that.' : 'No live site met the bar in the latest scan.'); td.colSpan = 5; tr.append(td); body.append(tr);
    }
    rows.slice(0, namedShown).forEach((r) => {
      const tr = el('tr');
      const site = el('td');
      const name = el('button', r.domain, 'sr-domain sr-site');
      name.type = 'button'; name.dataset.check = r.domain;
      site.append(name);
      if (r.title) site.append(el('span', `“${r.title}”`, 'sr-lure'));
      tr.append(site);
      tr.append(el('td', [r.kind, (r.impersonates || []).length ? `Pretends to be ${r.impersonates.join(', ')}` : ''].filter(Boolean).join('. ') || 'Not classified'));
      const evidence = [];
      if (r.kit) evidence.push(`Scam kit: ${r.kit}`);
      (r.listedBy || []).forEach((l) => evidence.push(`On a ${l}`));
      tr.append(el('td', `${evidence.join('; ')}. Score ${r.risk}`));
      const where = [(r.targets || []).length ? `Aimed at ${(r.targets || []).map(label).join(', ')}` : '',
        r.hostedIn ? `Hosted in ${label(r.hostedIn)}` : r.behindSharedNetwork ? 'Server hidden behind a shared network' : ''].filter(Boolean);
      tr.append(el('td', where.join('. ') || 'Not known'));
      tr.append(el('td', day(r.firstSeen)));
      body.append(tr);
    });
    const more = $('#sr-named-more');
    more.hidden = rows.length <= namedShown;
    more.textContent = `Show ${Math.min(NAMED_STEP, rows.length - namedShown)} more`;
  };

  const drawDowns = () => {
    const list = $('#sr-downs');
    list.replaceChildren();
    const rows = data.takedowns || [];
    if (!rows.length) { list.append(el('li', 'No named site has been taken down in the last seven days.')); return; }
    rows.slice(0, 40).forEach((r) => {
      const li = el('li');
      li.append(el('span', r.domain, 'sr-domain'));
      const where = (r.targets || []).map(inSentence).join(', ');
      const lived = r.livedHours ? `, up for about ${r.livedHours >= 48 ? `${Math.round(r.livedHours / 24)} days` : `${r.livedHours} h`}` : '';
      li.append(el('span', ` ${day(r.at)}${r.reason ? `. ${r.reason}` : ''}${lived}${where ? ` (aimed at ${where})` : ''}`));
      list.append(li);
    });
  };

  const drawBatches = () => {
    const body = $('#sr-batches tbody');
    if (!body) return;
    body.replaceChildren();
    const rows = data.batches || [];
    if (!rows.length) {
      const tr = el('tr'); const td = el('td', 'No bulk-registered batch stands out among this month’s new names.'); td.colSpan = 3; tr.append(td); body.append(tr);
      return;
    }
    rows.forEach((r) => {
      const tr = el('tr');
      tr.append(el('td', r.shape), el('td', num(r.names)), el('td', `${num(r.timesOverRepresented)} times`));
      body.append(tr);
    });
  };

  // ---------------------------------------------------------------- the console
  // What the scanner is doing, from what it last published
  const liveMode = () => {
    if (!data) return { mode: 'static' };
    const age = Math.max(0, (Date.now() - Date.parse(data.generated)) / 1000);
    const scan = data.scan || null;
    const every = (scan && scan.cycleSeconds) || 60;
    if (scan && scan.state === 'scanning' && age < every * 2.5) return { mode: 'scanning', age, every, scan };
    if (scan && scan.state === 'finished' && age < 600) return { mode: 'handover', age };
    if (age < 600) return { mode: 'waiting', age };
    return { mode: 'paused', age };
  };

  // Numbers roll to their new values, and say how much they moved since the update before
  const rolling = new WeakMap();
  const roll = (node, from, to) => {
    cancelAnimationFrame(rolling.get(node));
    if (reduceMotion || typeof from !== 'number' || from === to) { node.textContent = num(to); return; }
    const began = performance.now();
    const step = (now) => {
      const k = Math.min(1, (now - began) / 900);
      node.textContent = num(Math.round(from + (to - from) * (1 - (1 - k) ** 3)));
      if (k < 1) rolling.set(node, requestAnimationFrame(step));
    };
    rolling.set(node, requestAnimationFrame(step));
  };
  const drawStats = (before) => {
    const now = data.totals || {};
    const was = before && before.totals;
    // Only consecutive updates are compared: the copy in the page can be hours older than the first live one
    const consecutive = Boolean(was) && Date.parse(data.generated) - Date.parse(before.generated) <= 5 * 60000;
    document.querySelectorAll('#sr-stats dd').forEach((dd) => {
      const to = typeof now[dd.dataset.k] === 'number' ? now[dd.dataset.k] : 0;
      const from = was && typeof was[dd.dataset.k] === 'number' ? was[dd.dataset.k] : undefined;
      roll(dd, from, to);
      const chip = dd.parentElement.querySelector('.sr-delta');
      if (!chip) return;
      const change = consecutive && typeof from === 'number' ? to - from : 0;
      chip.textContent = change ? `${change > 0 ? '+' : '−'}${num(Math.abs(change))}` : '';
      chip.className = `sr-delta${change ? ' is-on' : ''}${change < 0 ? ' is-down' : ''}`;
    });
    const words = { live: 'up', unreachable: 'not answering', offline: 'gone from DNS', blocked: 'flagged by their host',
      parked: 'parked', suspended: 'suspended by their host', seized: 'seized', resolves: 'in DNS but not fetched',
      pending: 'still to be finished' };
    const states = (data.states || []).map((r) => `${num(r.sites)} ${words[r.state] || r.state}`);
    $('#sr-states').textContent = states.length ? `Of ${num(now.visited)} sites visited so far: ${states.join(', ')}.` : '';
  };

  // One bar per minute: sites visited in that minute's cycle, the ones found up in the darker part
  const drawCycles = (before) => {
    const chart = $('#sr-cycles-chart');
    if (!chart) return;
    const cycles = (data.recentCycles || []).filter((c) => Date.parse(c.at));
    const byMinute = new Map(cycles.map((c) => [Math.floor(Date.parse(c.at) / 60000), c]));
    const newest = cycles.length ? Math.max(...byMinute.keys()) : null;
    // While scanning the chart ends at the newest cycle; otherwise at this minute, so a pause shows as a gap
    const end = liveMode().mode === 'scanning' && newest !== null ? newest : minute();
    const start = end - SLOTS + 1;
    const shown = [...byMinute].filter(([m]) => m >= start && m <= end).map(([, c]) => c);
    const peak = Math.max(1, ...shown.map((c) => c.visited || 0));
    const had = new Set(((before && before.recentCycles) || []).map((c) => c.at));
    const cols = [];
    for (let m = start; m <= end; m += 1) {
      const c = byMinute.get(m);
      const col = el('span', null, c ? 'sr-col' : 'sr-col is-empty');
      if (c) {
        col.title = `${clock(c.at)}: ${plural(c.visited || 0, 'site')} visited, ${num(c.up || 0)} up, ${num(c.down || 0)} down` +
          `${c.firstVisits ? `, ${num(c.firstVisits)} seen for the first time` : ''}`;
        const down = el('i', null, 'sr-col-down');
        down.style.height = `${(100 * (c.down || 0)) / peak}%`;
        const up = el('i', null, 'sr-col-up');
        up.style.height = `${(100 * (c.up || 0)) / peak}%`;
        col.append(down, up);
        if (before && !had.has(c.at)) col.classList.add('is-new');
      }
      cols.push(col);
    }
    chart.replaceChildren(...cols);
    chartEnd = end;
    const visits = shown.reduce((sum, c) => sum + (c.visited || 0), 0);
    chart.setAttribute('aria-label', shown.length
      ? `Sites visited in each scan cycle over the last hour: ${plural(shown.length, 'cycle')}, ${plural(visits, 'visit')} in all`
      : 'No scan cycle in the last hour');
    $('#sr-cycles-from').textContent = clockOf(start * 60000);
    $('#sr-cycles-to').textContent = clockOf(end * 60000);
    const lc = data.lastCycle;
    $('#sr-cycle-now').textContent = lc
      ? `Last cycle${lc.at ? `, ${clock(lc.at)}` : ''}: ${plural(lc.visited || 0, 'site')} visited (${num(lc.up || 0)} up, ${num(lc.down || 0)} down)` +
        `${lc.newFromCertificates ? `, ${plural(lc.newFromCertificates, 'new name')} from certificate logs` : ''}` +
        `${lc.takedowns ? `, ${plural(lc.takedowns, 'takedown')}` : ''}.`
      : '';
  };

  // The newest events on named sites, beside the chart
  const drawLatest = (before) => {
    const wrap = $('#sr-console-latest');
    const rows = (data.feed || []).slice(0, 6);
    if (!wrap || !rows.length) { if (wrap) wrap.hidden = true; return; }
    const had = new Set(((before && before.feed) || []).map(feedKey));
    $('#sr-console-feed').replaceChildren(...rows.map((r) => {
      const li = el('li', null, `sr-ev-${String(r.type).replace(/[^a-z-]/g, '')}${before && !had.has(feedKey(r)) ? ' is-new' : ''}`);
      const when = el('time', ago(r.at), 'sr-ev-time');
      when.dateTime = r.at; when.dataset.at = r.at;
      const name = el('button', r.domain, 'sr-domain sr-site');
      name.type = 'button'; name.dataset.check = r.domain;
      li.append(when, el('b', r.text), name);
      return li;
    }));
    wrap.hidden = false;
  };

  // Every second: what the scanner is doing and when the next update is due
  const liveTick = () => {
    if (!data) return;
    const live = liveMode();
    let state;
    let detail;
    if (live.mode === 'scanning') {
      const due = live.every - live.age;
      state = 'Scanning now';
      detail = `${live.scan.cycle && live.scan.cycles ? `Cycle ${num(live.scan.cycle)} of ${num(live.scan.cycles)} in this run. ` : ''}` +
        `${due >= 1 ? `Next update in ${span(due)}.` : 'Next update any moment.'}`;
    } else if (live.mode === 'handover') {
      const due = HANDOVER_S - live.age;
      state = 'Moving to a fresh run';
      detail = `Once an hour the scan starts again on a new GitHub runner. ${due >= 1 ? `The next update is due in about ${span(due)}.` : 'The next update is due any moment.'}`;
    } else if (live.mode === 'waiting') {
      state = 'Waiting for the next update';
      detail = `The last one landed ${since(data.generated)}.`;
    } else {
      state = 'Paused';
      detail = `No new data since ${dayTime(data.generated)}, ${since(data.generated)}. The numbers below are from then.`;
    }
    $('#sr-console').dataset.mode = live.mode;
    $('#sr-live-state').textContent = state;
    $('#sr-live-detail').textContent = ` ${detail}`;
    $('#sr-age').textContent = live.mode === 'paused' ? 'Paused' : `Updated ${since(data.generated)}`;
    $('#sr-live-tag').classList.toggle('is-live', live.mode === 'scanning');
    if (live.mode !== 'scanning' && chartEnd !== minute()) drawCycles(null);
  };
  const tickTimes = () => document.querySelectorAll('.sr-ev-time[data-at]').forEach((node) => { node.textContent = ago(node.dataset.at); });

  // Jamaica watch: the hourly Jamaica hunt (hunt-jamaica.mjs) and Jamaican numbers on named scam sites.
  // A snapshot from before the hunt existed has no "jamaica": then only what the rest of it shows is used.
  const drawJamaica = () => {
    const jm = data.jamaica || null;
    const aimed = jm ? jm.liveAimedAtJamaica : ((data.byCountry || {}).JM || {}).live || 0;
    const named = jm ? jm.namedAimedAtJamaica : (data.named || []).filter((r) => (r.targets || []).includes('JM')).length;
    const rows = [['Live scam sites aimed at Jamaica', num(aimed)], ['Named here', num(named)]];
    if (jm) {
      rows.push(['Found by the hunt, watched', `${num(jm.huntWatching)}: ${num(jm.huntVisited)} visited so far, ${num(jm.huntUp)} up`]);
      rows.push(['Jamaican numbers on named scam sites', `${num(jm.jamaicanNumbers)}, on ${plural(jm.sitesWithJamaicanNumbers, 'site')}`]);
    }
    $('#sr-jm-stats').replaceChildren(...rows.map(([name, value]) => {
      const row = el('div');
      row.append(el('dt', name), el('dd', value));
      return row;
    }));
    const hunt = jm && jm.lastHunt;
    $('#sr-jm-hunt').textContent = hunt
      ? `Last hunt ${ago(hunt.at)}: ${plural(hunt.searches, 'search', 'searches')} of the scan archive and ${plural(hunt.keywords, 'word')} checked against the blocklists found ${plural(hunt.leads, 'lead')}, ${num(hunt.suspect)} of them suspicious and ${num(hunt.aimedAtJamaica)} aimed at Jamaica. ${num(hunt.added)} went on the watchlist.` +
        (jm.last24h && jm.last24h.hunts > 1 ? ` In the last 24 hours: ${num(jm.last24h.hunts)} hunts, ${plural(jm.last24h.added, 'site')} added.` : '')
      : 'No Jamaica hunt has finished yet. One starts with each hourly scan run and takes about eight minutes.';
  };

  const draw = (before) => {
    // What is new is marked only between consecutive updates: the copy in the page can be hours older
    // than the first live snapshot, and everything would look new
    const fresh = before && Date.parse(data.generated) - Date.parse(before.generated) <= 5 * 60000 ? before : null;
    drawStats(before);
    fillPicker();
    drawHome();
    drawJamaica();
    pickView();
    shadeMap(currentView());
    drawCycles(fresh);
    drawLatest(fresh);
    drawFeed(fresh);
    drawBoard();
    drawNamed();
    drawDowns();
    drawBatches();
    liveTick();
  };

  // ---------------------------------------------------------------- loading
  const adopt = (snapshot) => {
    if (!snapshot || typeof snapshot !== 'object' || !Date.parse(snapshot.generated)) return;
    if (data && Date.parse(snapshot.generated) <= Date.parse(data.generated)) return;
    const before = data;
    data = snapshot;
    draw(before);
  };
  const readStatus = async () => {
    if (statusApi) {
      const status = await getJson(STATUS_API);
      if (status && /^[0-9a-f]{40}$/.test(status.commit || '') && Date.parse(status.generated)) { apiMisses = 0; return status; }
      apiMisses += 1;
      if (apiMisses >= 3) statusApi = false; // this host has no status function: read the branch by name
    }
    return getJson(`${DATA}scam-radar-status.json?t=${Math.floor(Date.now() / REFRESH_MS)}`);
  };
  const latest = (at) => getJson(at ? `${RAW}${at}/scam-radar.json` : `${DATA}scam-radar.json?t=${Date.now()}`).then(adopt);
  let misses = 0;
  const poll = async () => {
    if (document.hidden) return; // a tab in the background catches up when it is shown again
    const status = await readStatus();
    if (!status) { misses += 1; if (misses % 4 === 0) await latest(null); return; }
    misses = 0;
    if (!data || Date.parse(status.generated) > Date.parse(data.generated)) {
      if (status.commit) commit = status.commit;
      await latest(status.commit || null);
    }
  };
  const start = async () => {
    const local = getJson(LOCAL).then(adopt);
    const status = await readStatus();
    if (status && status.commit) commit = status.commit;
    await Promise.all([local, latest(commit)]);
    if (!data) $('#sr-live-detail').textContent = ' The latest scan could not be loaded. This page tries again every 15 seconds.';
  };

  // ---------------------------------------------------------------- check a site
  const LEVEL_WORDS = {
    critical: 'Almost certainly a scam',
    high: 'Very likely a scam',
    medium: 'Suspicious',
    low: 'No strong scam signals found',
  };
  const STATE_WORDS = {
    live: 'It was up',
    offline: 'It was gone from DNS',
    unreachable: 'Its server was not answering',
    resolves: 'It was in DNS but had not been fetched',
    pending: 'The visit had not finished',
    suspended: 'Its host had suspended it',
    seized: 'It had been seized by law enforcement',
    parked: 'It was parked or up for sale',
    blocked: 'Its host had flagged it as phishing',
  };
  const sha12 = async (name) => {
    const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(name)));
    return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 12);
  };
  // Radar's record for a site, if it has one. undefined means its records could not be reached.
  const lookup = async (names) => {
    let reached = false;
    for (const name of names) {
      const key = await sha12(name);
      const shard = await getJson(commit ? `${RAW}${commit}/lookup/${key.slice(0, 2)}.json`
        : `${DATA}lookup/${key.slice(0, 2)}.json?t=${Math.floor(minute() / 10)}`);
      if (!shard) continue;
      reached = true;
      if (shard[key]) return { name, record: shard[key] };
    }
    return reached ? null : undefined;
  };
  let apiHere = null;
  const hasApi = async () => {
    if (apiHere === null) {
      const pong = await getJson(`${API}?ping=1`);
      apiHere = Boolean(pong && pong.ok === true && pong.tool === 'scam-finder');
    }
    return apiHere;
  };

  const block = (title) => {
    const box = el('div', null, 'sr-check-block');
    box.append(el('h4', title));
    return box;
  };
  const bullets = (items, cls) => {
    const list = el('ul', null, cls || 'sr-reasons');
    items.forEach((item) => list.append(el('li', item)));
    return list;
  };
  const facts = (pairs) => {
    const dl = el('dl', null, 'sr-facts');
    pairs.filter(([, value]) => value).forEach(([name, value]) => {
      const row = el('div');
      row.append(el('dt', name), el('dd', value));
      dl.append(row);
    });
    return dl;
  };

  const defangName = (name) => String(name || '').replace(/\.$/, '').replace(/\./g, '[.]');
  const hostOf = (url) => { try { return new URL(url).hostname; } catch { return ''; } };
  const LINK_WORDS = { title: 'same page title', ip: 'same server', kit: 'same scam kit', path: 'same unusual file path',
    hash: 'identical file', resource: 'loads a file from it', ns: 'same nameservers', cert: 'same certificate',
    query: 'found by a search', tracker: 'same tracker', contact: 'same contact', structure: 'same page layout' };
  // The deep dive, in five parts: the site now, its registration, its servers and mail, its history,
  // and the sites linked to it. Everything comes from Scam Finder's investigation of the link.
  const deepBlocks = (result, seed) => {
    const blocks = [];
    const page = seed.page || {};
    const reg = seed.registration || {};
    const dnsr = seed.dns || {};
    const certs = seed.certificates || {};
    const scans = seed.scans || null;
    const title = result.deep ? 'Deep dive: the site right now' : 'A visit just now';
    const now = block(title);
    const up = seed.live ? (seed.live.ok ? `Up, answering with HTTP ${seed.live.status}` : `No answer${seed.live.error ? `: ${seed.live.error}` : ''}`)
      : seed.state === 'offline' ? 'Gone from DNS' : 'Not reached';
    const finalHost = hostOf(page.finalUrl);
    const withheld = Object.entries(page.contactsWithheld || {}).map(([kind, n]) => plural(n, kind));
    const external = page.externalHosts || [];
    now.append(facts([
      ['Right now', up],
      ['Shows', seed.title ? `“${seed.title}”` : ''],
      ['Ends up at', finalHost && finalHost !== seed.domain && !finalHost.endsWith(`.${seed.domain}`) ? defangName(finalHost) : ''],
      ['Scam kit', (seed.kits || []).map((k) => k.name).join(', ')],
      ['Pretends to be', (seed.brands || []).filter((b) => !b.official && (b.inDomain || b.inTitle)).map((b) => b.name).join(', ')],
      ['Bait', (seed.lures || []).map((l) => l.label).join(', ')],
      ['Link preview claims', page.spoofedHost ? defangName(page.spoofedHost) : ''],
      ['Asks for', [page.forms && page.forms.passwordFields ? 'a password' : '', page.forms && page.forms.cardFields ? 'card details' : ''].filter(Boolean).join(' and ')],
      ['Sends forms to', ((page.forms && page.forms.actionHosts) || []).map(defangName).join(', ')],
      ['Loads files from', external.length ? `${plural(external.length, 'other host')}: ${external.slice(0, 5).map(defangName).join(', ')}${external.length > 5 ? ', …' : ''}` : ''],
      ['Listed on', (seed.blocklists || []).map((b) => b.name).join(', ')],
      ['On the page', withheld.length ? `${withheld.join(', ')} (not shown here)` : ''],
    ]));
    if (result.partial) now.append(el('p', 'The deep dive ran out of time before every source answered, so some facts may be missing.', 'sr-note'));
    if (result.deepError) now.append(el('p', `The deep dive could not run (${result.deepError}), so this is the short visit.`, 'sr-note'));
    blocks.push(now);

    const who = block('Registration');
    who.append(facts([
      ['Registered', reg.created ? `${dayYear(reg.created)}${typeof reg.ageDays === 'number' ? `, ${plural(reg.ageDays, 'day')} ago` : ''}` : 'Not published'],
      ['Registrar', reg.registrar],
      ['Expires', reg.expires ? dayYear(reg.expires) : ''],
      ['Status', (reg.statuses || []).join(', ')],
      ['Signed with DNSSEC', reg.dnssec === true ? 'Yes' : reg.dnssec === false ? 'No' : ''],
      ['Registrant', [reg.registrantOrg, isCC(reg.registrantCountry) ? label(reg.registrantCountry) : ''].filter(Boolean).join(', ')],
      ['Report abuse to', reg.abuseEmail],
    ]));
    blocks.push(who);

    const servers = block('Servers and mail');
    servers.append(facts([
      ['Server', (seed.network || []).slice(0, 3).map((n) => [n.ip, n.shared ? `behind ${n.shared}, so the real server is hidden` : '', n.asnName,
        isCC(n.country) ? label(n.country) : ''].filter(Boolean).join(', ')).join('; ')],
      ['Nameservers', [(dnsr.ns || []).slice(0, 4).map((n) => defangName(n)).join(', '), seed.nameservers && seed.nameservers.provider].filter(Boolean).join(' · ')],
      ['Mail servers', Array.isArray(dnsr.mx) ? (dnsr.mx.length ? `${plural(dnsr.mx.length, 'mail server')}: it can receive email` : 'None: it cannot receive email') : ''],
      ['Sender rules (SPF)', dnsr.spf === true ? 'Published' : dnsr.spf === false ? 'None published' : ''],
    ]));
    blocks.push(servers);

    const past = block('History');
    past.append(facts([
      ['Certificates', certs.count ? `${plural(certs.count, 'certificate')}${certs.firstIssued ? ` since ${dayYear(certs.firstIssued)}` : ''}` : 'None found in certificate logs'],
      ['Names on its certificates', (certs.hosts || []).slice(0, 8).map(defangName).join(', ')],
      ['Earlier scans', scans && scans.count ? `${plural(scans.count, 'scan')} on urlscan.io, ${dayYear(scans.first)} to ${dayYear(scans.last)}` : 'None found on urlscan.io'],
      ['Titles seen before', scans ? (scans.titles || []).slice(0, 3).map((t) => `“${t.title}”`).join(', ') : ''],
      ['Its name', seed.lexical && seed.lexical.randomLooking ? 'Looks machine-generated' : ''],
    ]));
    blocks.push(past);

    const related = (result.domains || []).filter((d) => d !== seed && d.domain);
    const links = block('Sites linked to it');
    if (!related.length) {
      links.append(el('p', `No other site shares its title, files or server in the scan archives${result.deep ? '' : ' the short visit searched'}.`, 'sr-note'));
    } else {
      links.append(el('p', `${plural(related.length, 'site')} ${related.length === 1 ? 'shares' : 'share'} something with it. Click one to check it.`, 'sr-note'));
      const list = el('ul', null, 'sr-linked');
      related.sort((a, b) => ((b.risk && b.risk.score) || 0) - ((a.risk && a.risk.score) || 0)).slice(0, 12).forEach((d) => {
        const li = el('li', null, `sr-level-${(d.risk && d.risk.level) || 'low'}`);
        const name = el('button', defangName(d.domain), 'sr-domain sr-site');
        name.type = 'button'; name.dataset.check = defangName(d.domain);
        const why = [...new Set((d.foundBy || []).map((f) => LINK_WORDS[f.type] || f.type))].slice(0, 3).join(', ');
        li.append(name, el('span', ` ${LEVEL_WORDS[(d.risk && d.risk.level) || 'low'] || ''}${d.risk ? `, ${d.risk.score}` : ''}${why ? `. ${why}` : ''}`));
        list.append(li);
      });
      links.append(list);
    }
    const map = el('a', 'Map the sites linked to it', 'btn btn-ghost btn-sm');
    map.href = `/scam-radar/map/?url=${encodeURIComponent((result.seed && result.seed.url) || seed.domain)}`;
    links.append(map);
    blocks.push(links);

    const score = block('Why it scores what it does');
    const why = ((seed.risk && seed.risk.signals) || []).map((s) => s.label);
    score.append(why.length ? bullets(why) : el('p', 'Nothing in the visit raised its score.', 'sr-note'));
    const code = (seed.findings || []).map((f) => `${f.label}${f.hidden ? ' (hidden in encoded script)' : ''}`);
    if (code.length) { score.append(el('p', 'What its code does:', 'sr-home-label')); score.append(bullets(code)); }
    blocks.push(score);
    return blocks;
  };

  const renderCheck = (verdict, state) => {
    const out = $('#sr-check-result');
    out.replaceChildren();
    const radar = state.radar && state.radar.record;
    const domains = (state.live && state.live.domains) || [];
    const seed = domains.find((d) => d.role === 'seed') || domains[0];
    // The headline follows the best evidence there is: a live visit, then Radar's record, then the address
    const best = seed && seed.risk ? { score: seed.risk.score, level: seed.risk.level,
      from: state.live.deep ? 'from a deep dive into the site just now' : 'from a visit to the site just now' }
      : radar ? { score: radar.risk, level: radar.level, from: `from Radar’s ${plural(radar.checks || 1, 'visit')} to the site` }
        : { score: verdict.score, level: verdict.level, from: 'from the address alone; the site was not visited' };
    const trusted = verdict.wellKnown || (verdict.official.length && best.level === 'low');

    const head = el('div', null, `sr-verdict sr-level-${trusted ? 'low' : best.level}`);
    head.append(el('p', verdict.shown, 'sr-domain sr-verdict-name'));
    const line = el('p', null, 'sr-verdict-line');
    line.append(el('strong', verdict.official.length && best.level === 'low' ? `This is ${verdict.official[0]}’s own domain`
      : verdict.wellKnown ? 'A well-known legitimate service' : LEVEL_WORDS[best.level] || 'Checked'));
    if (!trusted) line.append(el('span', ` Score ${best.score} out of 100, ${best.from}.`));
    head.append(line);
    out.append(head);

    // 1. the address
    const address = block('The address');
    const says = verdict.signals.map((s) => s.label);
    if (verdict.official.length) says.unshift(`The domain belongs to ${verdict.official.join(', ')}`);
    verdict.mitigations.forEach((text) => says.push(text));
    address.append(says.length ? bullets(says) : el('p', 'Nothing about the address itself stands out. Many scam sites have ordinary-looking names, so this alone proves little.', 'sr-note'));
    if (verdict.looksRandom && verdict.mould) address.append(el('p', `Its shape, ${verdict.mould}, is the kind of name scripts register in bulk.`, 'sr-note'));
    out.append(address);

    // 2. Radar's record
    const record = block('Radar’s record');
    if (state.radar === 'loading') record.append(el('p', 'Looking it up.', 'sr-note'));
    else if (verdict.isIp) record.append(el('p', 'Radar keeps its records by domain name, so it has nothing filed under a bare IP address.', 'sr-note'));
    else if (state.radar === undefined) record.append(el('p', 'Radar’s records could not be reached just now. Try again in a minute.', 'sr-note'));
    else if (!radar) {
      record.append(el('p', `Radar has no record of this site. It has visited ${num(((data || {}).totals || {}).visited)} of the most suspicious names so far and keeps records for those scoring 40 or more, so no record is not a clean bill of health.`, 'sr-note'));
    } else {
      const down = radar.takenDown ? `Taken down on ${dayYear(radar.takenDown)}` : radar.downSince ? `Down since ${dayYear(radar.downSince)}` : null;
      record.append(el('p', `${STATE_WORDS[radar.state] || 'It was checked'} when Radar last visited, ${ago(radar.lastChecked)}.${down ? ` ${down}.` : ''}${radar.downReason ? ` ${radar.downReason}.` : ''}`, 'sr-note'));
      if (radar.hacked) {
        record.append(el('p', `This looks like a real site that was hacked to host a scam page: its domain was registered${radar.registered ? ` on ${dayYear(radar.registered)}` : ''}, long before the scam page appeared. Radar counts it but does not name it as a scam site. If it is yours, the scam page is a file someone put on your hosting: remove it and change your hosting and site passwords.`, 'sr-note sr-hacked'));
      }
      record.append(facts([
        ['Kind', radar.kind],
        ['Scam kit', radar.kit],
        ['Pretends to be', (radar.brands || []).join(', ')],
        ['Shows', radar.title ? `“${radar.title}”` : ''],
        ['Aimed at', (radar.targets || []).map(label).join(', ')],
        ['Hosted', radar.shared ? `Behind ${radar.network || 'a shared network'}, so the real server is hidden` : [radar.hostedIn && label(radar.hostedIn), radar.network].filter(Boolean).join(', ')],
        ['Listed on', (radar.listedBy || []).map((l) => `a ${l}`).join(', ')],
        ['Registered', [radar.registered && dayYear(radar.registered), radar.registrar && `through ${radar.registrar}`].filter(Boolean).join(' ')],
        ['Watched since', `${dayYear(radar.firstSeen)}, ${plural(radar.checks || 0, 'visit')}${typeof radar.upShare === 'number' ? `, up on ${radar.upShare}% of them` : ''}`],
      ]));
      if ((radar.why || []).length) { record.append(el('p', 'Why it scores what it does:', 'sr-home-label')); record.append(bullets(radar.why)); }
      if ((radar.code || []).length) { record.append(el('p', 'What its code does:', 'sr-home-label')); record.append(bullets(radar.code)); }
    }
    out.append(record);

    // 3. the deep dive, where this host can make one
    if (state.live === 'loading') {
      const live = block('Deep dive');
      live.append(el('p', 'Visiting the site as plain text (nothing on it is run), reading its registration, DNS and mail servers, its certificates and earlier scans, and searching for other sites that share its title, files or server. This takes up to 40 seconds.', 'sr-note'));
      const clock = el('p', '0 s', 'sr-deep-clock');
      clock.dataset.started = String(state.started || Date.now());
      live.append(clock);
      out.append(live);
    } else if (state.live !== 'none' && seed) {
      deepBlocks(state.live, seed).forEach((node) => out.append(node));
    } else if (state.live !== 'none') {
      const live = block('Deep dive');
      live.append(el('p', (state.live && state.live.error) || 'The visit could not be finished. Try again in a minute.', 'sr-note'));
      out.append(live);
    }
    const advice = el('div', null, 'sr-check-block sr-advice');
    advice.append(el('p', 'A score is a reason to look, not a verdict. Low does not mean safe: it means nothing was found.'));
    const report = el('p', 'If it is a scam, report it so browsers warn the next person: ');
    const link = el('a', 'Google Safe Browsing');
    link.href = 'https://safebrowsing.google.com/safebrowsing/report_phish/'; link.rel = 'noopener'; link.target = '_blank';
    report.append(link, '. Tell the company it copies through its real website, and call your bank if you paid.');
    advice.append(report);
    out.append(advice);
  };

  // ---------------------------------------------------------------- check a contact
  const KIND_WORDS = { email: 'Email address', phone: 'Phone number', telegram: 'Telegram account',
    bitcoin: 'Bitcoin wallet', ethereum: 'Ethereum wallet', tron: 'TRON wallet' };
  const FREE_MAIL = new Set(['gmail.com', 'googlemail.com', 'yahoo.com', 'outlook.com', 'hotmail.com', 'live.com', 'icloud.com',
    'aol.com', 'proton.me', 'protonmail.com', 'gmx.com', 'mail.com', 'yandex.com', 'zoho.com']);
  // What was pasted, if it is a contact and not a link, spelled the way Radar records contacts
  const contactOf = (raw) => {
    const text = String(raw || '').trim();
    const mail = text.replace(/^mailto:/i, '').toLowerCase();
    if (/^[^@\s/:]+@[^@\s/:]+\.[a-z]{2,24}$/.test(mail)) return { kind: 'email', value: mail, domain: mail.slice(mail.indexOf('@') + 1) };
    const tg = text.match(/^(?:@|(?:https?:\/\/)?(?:www\.)?(?:t\.me|telegram\.me)\/)(\+?[a-z0-9_]{5,40})\/?$/i);
    if (tg) return { kind: 'telegram', value: tg[1].toLowerCase() };
    const wa = text.match(/^(?:https?:\/\/)?(?:wa\.me\/|(?:api\.)?whatsapp\.com\/send\/?\?phone=)\+?(\d{7,15})/i);
    if (wa) return { kind: 'phone', value: `+${wa[1]}` };
    if (/^(?:\+|00)?[\d\s().-]{7,22}$/.test(text) && !/^\d{1,3}(?:\.\d{1,3}){3}$/.test(text)) {
      let digits = text.replace(/\D/g, '');
      const international = text.startsWith('+') || text.startsWith('00');
      if (text.startsWith('00')) digits = digits.slice(2);
      // Ten digits with no country code: North America and the Caribbean, Jamaica included (+1)
      else if (!international && digits.length === 10 && /^[2-9]/.test(digits)) digits = `1${digits}`;
      // Anything else without a country code can't be matched to the numbers Radar keeps
      else if (!international && !(digits.length === 11 && digits.startsWith('1'))) return { kind: 'phone', value: null, needsArea: true };
      if (digits.length >= 8 && digits.length <= 15) return { kind: 'phone', value: `+${digits}` };
    }
    if (/^bc1[ac-hj-np-z02-9]{25,59}$/i.test(text)) return { kind: 'bitcoin', value: text.toLowerCase() };
    if (/^0x[a-f0-9]{40}$/i.test(text)) return { kind: 'ethereum', value: text.toLowerCase() };
    if (/^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(text)) return { kind: 'tron', value: text };
    return null;
  };
  // Radar's record for a contact, looked up by a key worked out here, so what was typed never leaves
  // the browser. The key is a slow one-way hash (PBKDF2-SHA256, a million rounds, as in export.mjs),
  // so the published files can't be read back as a list by hashing every number in a country.
  // undefined means the records could not be reached.
  const CONTACT_SALT = 'corx-labs scam-radar contacts v1';
  const contactKey = async (id) => {
    const text = new TextEncoder();
    const base = await crypto.subtle.importKey('raw', text.encode(id), 'PBKDF2', false, ['deriveBits']);
    const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: text.encode(CONTACT_SALT), iterations: 1000000 }, base, 64);
    return [...new Uint8Array(bits)].map((b) => b.toString(16).padStart(2, '0')).join('');
  };
  // Every export writes all 256 files, so a missing one means none has been published yet
  const lookupContact = async (c) => {
    const key = await contactKey(`${c.kind}:${c.value}`.toLowerCase());
    const answer = await fetch(commit ? `${RAW}${commit}/contacts/${key.slice(0, 2)}.json`
      : `${DATA}contacts/${key.slice(0, 2)}.json?t=${Math.floor(minute() / 10)}`, { cache: 'no-cache' }).catch(() => null);
    if (answer && answer.status === 404) return 'unpublished';
    const shard = answer && answer.ok ? await answer.json().catch(() => null) : null;
    if (!shard) return undefined;
    return shard[key] || null;
  };
  const renderContact = (raw, c, state) => {
    const out = $('#sr-check-result');
    out.replaceChildren();
    const rec = state.radar && typeof state.radar === 'object' ? state.radar : null;
    const head = el('div', null, `sr-verdict sr-level-${rec ? (rec.live ? 'critical' : 'high') : 'low'}`);
    head.append(el('p', `${KIND_WORDS[c.kind]}: ${c.value}`, 'sr-domain sr-verdict-name'));
    const line = el('p', null, 'sr-verdict-line');
    line.append(el('strong', state.radar === 'loading' ? 'Checking' : rec ? `Seen on ${plural(rec.sites, 'named scam site')}`
      : state.radar === undefined ? 'Radar’s records could not be reached'
        : state.radar === 'unpublished' ? 'Radar’s contact records are not published yet' : 'Not seen on any named scam site'));
    if (rec) line.append(el('span', ` ${rec.live ? `${num(rec.live)} up when last visited. ` : ''}First seen ${dayYear(rec.first)}.`));
    head.append(line);
    out.append(head);

    const record = block('Radar’s record');
    if (state.radar === 'loading') record.append(el('p', 'Looking it up.', 'sr-note'));
    else if (state.radar === undefined) record.append(el('p', 'Radar’s records could not be reached just now. Try again in a minute.', 'sr-note'));
    else if (state.radar === 'unpublished') record.append(el('p', 'The first contact records are published by the next hourly scan run. Try again in an hour.', 'sr-note'));
    else if (!rec) {
      record.append(el('p', `Radar keeps the contacts that named scam sites ask people to use, and this ${c.kind === 'email' ? 'address' : c.kind === 'phone' ? 'number' : 'one'} is not among them. That is not a clean bill of health: most scams are never seen by any scanner.`, 'sr-note'));
    } else {
      record.append(facts([
        ['Scam sites', `${plural(rec.sites, 'named site')}${rec.live ? `, ${num(rec.live)} up when last visited` : ''}`],
        ['Kind of scam', (rec.kinds || []).join(', ')],
        ['Pretending to be', (rec.brands || []).join(', ')],
        ['Seen', rec.first ? `${dayYear(rec.first)} to ${dayYear(rec.last)}` : ''],
      ]));
      if ((rec.names || []).length) {
        record.append(el('p', 'Sites it was on (click one to check it):', 'sr-home-label'));
        const list = el('ul', null, 'sr-linked');
        rec.names.forEach((name) => {
          const li = el('li');
          const button = el('button', name, 'sr-domain sr-site');
          button.type = 'button'; button.dataset.check = name;
          li.append(button);
          list.append(li);
        });
        record.append(list);
      }
    }
    record.append(el('p', 'A contact on a scam page is often a hijacked, spoofed or throwaway account, so this is a lead about the scam, not who is behind it.', 'sr-note'));
    out.append(record);

    // What the address or number says about itself: Scam Finder's contact check, on this site's server
    if (state.info !== 'none') {
      const self = block(c.kind === 'phone' ? 'What the number says about itself' : 'What the address says about itself');
      const info = state.info;
      if (info === 'loading') self.append(el('p', 'Asking spam-report services.', 'sr-note'));
      else if (!info || info.error) self.append(el('p', (info && info.error) || 'The check could not be finished.', 'sr-note'));
      else {
        const spam = info.spamReports;
        const breaches = info.breachExposure && Array.isArray(info.breachExposure.breaches) ? info.breachExposure.breaches : null;
        self.append(facts([
          ['Mailbox', info.kind === 'email' ? ({ throwaway: 'A disposable mailbox', 'free-webmail': 'A free webmail account',
            'own-domain': `On its own domain, ${defangName(info.domain)}` }[info.provider] || '') : ''],
          ['Country', info.kind === 'phone' ? (isCC(info.country) ? label(info.country) : 'Not known from the number') : ''],
          ['Spam reports', spam ? (spam.reported ? `Reported ${plural(spam.reports, 'time')}${dayYear(String(spam.lastSeen || '').replace(' ', 'T')) ? `, last on ${dayYear(String(spam.lastSeen).replace(' ', 'T'))}` : ''} (StopForumSpam)` : 'None (StopForumSpam)') : ''],
          ['Data breaches', breaches ? (breaches.length ? breaches.slice(0, 6).map((b) => `${b.name}${b.date ? ` (${b.date})` : ''}`).join(', ') : 'In none known to Have I Been Pwned') : ''],
        ]));
        if ((info.notes || []).length) self.append(bullets(info.notes));
      }
      out.append(self);
    }

    // An address on its own domain: the domain can be checked like any site
    const provider = state.info && state.info.provider;
    if (c.kind === 'email' && c.domain && !FREE_MAIL.has(c.domain) && (!provider || provider === 'own-domain')) {
      const box = block('Its domain');
      box.append(el('p', 'An address on its own domain says more than a free mailbox: the domain can be checked like any site.', 'sr-note'));
      const button = el('button', `Deep-dive ${defangName(c.domain)}`, 'btn btn-ghost btn-sm');
      button.type = 'button'; button.dataset.check = c.domain;
      box.append(button);
      out.append(box);
    }
    const advice = el('div', null, 'sr-check-block sr-advice');
    advice.append(el('p', 'Never send money, a code or a password to a contact from a message you did not expect. Call the company on the number on its own website, and report the scam to the police.'));
    out.append(advice);
  };
  const runContactCheck = async (raw, c, scroll) => {
    const out = $('#sr-check-result');
    const run = ++checkRun;
    if (scroll) { $('#sr-check-input').value = raw; $('#check').scrollIntoView({ behavior: 'smooth', block: 'start' }); }
    if (c.needsArea) {
      out.replaceChildren(el('p', 'Add the area code (876 or 658 for a Jamaican number) or the country code, so the number can be matched.', 'sr-check-error'));
      return;
    }
    renderContact(raw, c, { radar: 'loading', info: 'none' });
    const online = c.kind === 'email' || c.kind === 'phone';
    const [radar, api] = await Promise.all([lookupContact(c).catch(() => undefined), online ? hasApi() : Promise.resolve(false)]);
    if (run !== checkRun) return;
    renderContact(raw, c, { radar, info: api ? 'loading' : 'none' });
    if (!api) return;
    const answer = await askApi(`contact=${encodeURIComponent(c.value)}`);
    if (run !== checkRun) return;
    renderContact(raw, c, { radar, info: answer && answer.status === 200 && answer.body ? answer.body
      : { error: (answer && answer.body && answer.body.error) || 'The check could not be finished. Try again in a minute.' } });
  };

  // The deep dive (depth 2) needs a host that lets a function run for up to a minute. Where it can't
  // run, or this address has used its deep dives for now, the short visit is made instead.
  const askApi = (query) => fetch(`${API}?${query}`)
    .then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) })).catch(() => null);
  const deepDive = async (url) => {
    const deep = await askApi(`depth=2&url=${encodeURIComponent(url)}`);
    if (deep && deep.status === 200 && deep.body && deep.body.domains) return { ...deep.body, deep: true };
    const quick = await askApi(`url=${encodeURIComponent(url)}`);
    if (quick && quick.status === 200 && quick.body && quick.body.domains) {
      return { ...quick.body, deep: false, deepError: (deep && deep.body && deep.body.error) || 'the server took too long' };
    }
    return { error: (deep && deep.body && deep.body.error) || (quick && quick.body && quick.body.error) || 'The visit could not be finished. Try again in a minute.' };
  };
  // The seconds count while a deep dive runs
  setInterval(() => document.querySelectorAll('.sr-deep-clock').forEach((node) => {
    node.textContent = `${Math.round((Date.now() - Number(node.dataset.started)) / 1000)} s`;
  }), 1000);

  let checkRun = 0;
  const runCheck = async (raw, scroll) => {
    const out = $('#sr-check-result');
    const input = $('#sr-check-input');
    const core = window.ScamFinderCore;
    const pasted = contactOf(raw);
    if (pasted) { runContactCheck(raw, pasted, scroll); return; }
    const run = ++checkRun;
    let verdict;
    try {
      if (!core) throw new Error('The checker did not load. Reload the page and try again.');
      verdict = core.judge(raw);
    } catch (error) {
      out.replaceChildren(el('p', String(error.message || error).replace(/^Error: /, ''), 'sr-check-error'));
      return;
    }
    if (scroll) { // asked for by clicking a name on the page: show what is being checked
      input.value = verdict.shown;
      $('#check').scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
    renderCheck(verdict, { radar: 'loading', live: 'none' });
    const [radar, api] = await Promise.all([lookup(verdict.names).catch(() => undefined), hasApi()]);
    if (run !== checkRun) return;
    renderCheck(verdict, { radar, live: api ? 'loading' : 'none', started: Date.now() });
    if (!api) return;
    const live = await deepDive(verdict.url);
    if (run !== checkRun) return;
    renderCheck(verdict, { radar, live });
  };

  // ---------------------------------------------------------------- wiring
  document.querySelectorAll('input[name="sr-view"]').forEach((input) =>
    input.addEventListener('change', () => { viewChosen = true; if (data) shadeMap(input.value); }));
  $('#sr-country').addEventListener('change', (event) => {
    const cc = event.target.value;
    if (isCC(cc)) { home = cc; store.set('scam-radar-country', cc); }
    if (data) { drawHome(); shadeMap(currentView()); }
  });
  $('#sr-named-filter').addEventListener('input', () => { namedShown = NAMED_STEP; if (data) drawNamed(); });
  $('#sr-named-more').addEventListener('click', () => { namedShown += NAMED_STEP; if (data) drawNamed(); });
  $('#sr-jm-named').addEventListener('click', () => {
    $('#sr-named-filter').value = 'Jamaica';
    namedShown = NAMED_STEP;
    if (data) drawNamed();
    $('#named').scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'start' });
  });
  $('#sr-check').addEventListener('submit', (event) => {
    event.preventDefault();
    const value = $('#sr-check-input').value.trim();
    if (value) runCheck(value, false);
  });
  // Any site name on the page can be checked by clicking it
  document.addEventListener('click', (event) => {
    const button = event.target.closest('[data-check]');
    if (button) runCheck(button.dataset.check, true);
  });

  guessCountry().then((cc) => { home = cc; if (data) draw(null); });
  start();
  setInterval(poll, REFRESH_MS);
  setInterval(liveTick, 1000);
  setInterval(tickTimes, 5000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) poll(); });
  const preset = new URLSearchParams(location.search).get('check');
  if (preset) runCheck(preset, true);
})();
