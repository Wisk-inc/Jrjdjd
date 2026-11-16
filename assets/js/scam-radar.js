/* Scam Radar: draws what the scanner publishes, and checks a single site on request.
   - Data: the newest of the published snapshot (scam-radar-data branch) and the copy on this site.
     Whichever answers first is drawn at once; a tiny status file is polled every minute after that.
   - "Your country" is guessed from the device's time zone, on the device. Nothing is sent anywhere.
   - "Check a site" has three parts: the address judged by Scam Finder's own rules in the browser
     (scam-finder-core.js), Radar's record for the site (looked up by a hash of its name), and, where
     this host runs the API, a live visit.
   Every value from the data goes in through textContent, never as HTML. No checked site is ever linked. */
(() => {
  'use strict';
  const DATA = 'https://raw.githubusercontent.com/Wisk-inc/Jrjdjd/scam-radar-data/';
  const LOCAL = '/assets/data/scam-radar.json';
  const API = '/api/scam-finder';
  const REFRESH_MS = 60 * 1000;
  const STALE_HOURS = 6;
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
    const m = Math.max(0, Math.round((Date.now() - t) / 60000));
    if (m < 1) return 'just now';
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

  let data = null;
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
  const drawFeed = () => {
    const list = $('#sr-feed');
    list.replaceChildren();
    const rows = data.feed || [];
    if (!rows.length) list.append(el('li', 'Nothing has changed on a named site in the last two days.', 'sr-empty'));
    rows.slice(0, 40).forEach((r) => {
      const li = el('li', null, `sr-ev sr-ev-${String(r.type).replace(/[^a-z-]/g, '')}`);
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
    $('#sr-named-count').textContent = filter
      ? `${plural(rows.length, 'match', 'matches')} among the ${num(all.length)} listed`
      : `${plural(total, 'live site')} ${total === 1 ? 'meets' : 'meet'} the bar${total > all.length ? `; the ${num(all.length)} with the highest scores are listed` : ''}`;
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

  // ---------------------------------------------------------------- status, ticking every second
  const tick = () => {
    if (!data) return;
    const hours = (Date.now() - Date.parse(data.generated)) / 3600000;
    const totals = data.totals || {};
    $('#sr-status').textContent = `Last scan published ${since(data.generated)}, after ${num(data.scanCycles)} scan cycles and ${num(totals.visitsMade)} site visits. ` +
      (hours > STALE_HOURS ? 'That is older than it should be: the scheduled scan may have stopped.' : 'This page checks for a new one every minute.');
    $('#sr-age').textContent = hours > STALE_HOURS ? 'Data out of date' : `Updated ${since(data.generated)}`;
  };
  const tickTimes = () => document.querySelectorAll('.sr-ev-time[data-at]').forEach((node) => { node.textContent = ago(node.dataset.at); });

  const draw = () => {
    document.querySelectorAll('#sr-stats dd').forEach((dd) => { dd.textContent = num((data.totals || {})[dd.dataset.k]); });
    fillPicker();
    drawHome();
    pickView();
    shadeMap(currentView());
    drawFeed();
    drawBoard();
    drawNamed();
    drawDowns();
    drawBatches();
    tick();
  };

  // ---------------------------------------------------------------- loading
  const adopt = (snapshot) => {
    if (!snapshot || typeof snapshot !== 'object' || !Date.parse(snapshot.generated)) return;
    if (data && Date.parse(snapshot.generated) <= Date.parse(data.generated)) return;
    data = snapshot;
    draw();
  };
  const latest = () => getJson(`${DATA}scam-radar.json?t=${minute()}`).then(adopt);
  const poll = async () => {
    const status = await getJson(`${DATA}scam-radar-status.json?t=${minute()}`);
    if (!status) { await latest(); return; } // an older publish with no status file
    if (!data || Date.parse(status.generated) > Date.parse(data.generated)) await latest();
  };
  const start = async () => {
    await Promise.all([getJson(LOCAL).then(adopt), latest()]);
    if (!data) $('#sr-status').textContent = 'The latest scan could not be loaded. This page will try again in a minute.';
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
      const shard = await getJson(`${DATA}lookup/${key.slice(0, 2)}.json?t=${Math.floor(minute() / 10)}`);
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

  const renderCheck = (verdict, state) => {
    const out = $('#sr-check-result');
    out.replaceChildren();
    const radar = state.radar && state.radar.record;
    const seed = state.live && state.live.domains && state.live.domains[0];
    // The headline follows the best evidence there is: a live visit, then Radar's record, then the address
    const best = seed ? { score: seed.risk.score, level: seed.risk.level, from: 'from a visit to the site just now' }
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

    // 3. a live visit, where this host can make one
    if (state.live !== 'none') {
      const live = block('A visit just now');
      if (state.live === 'loading') live.append(el('p', 'Visiting the site as plain text. Nothing on it is run. This takes about five seconds.', 'sr-note'));
      else if (!seed) live.append(el('p', (state.live && state.live.error) || 'The visit could not be finished. Try again in a minute.', 'sr-note'));
      else {
        const page = seed.page || {};
        const reg = seed.registration || {};
        const net = (seed.network || [])[0] || {};
        const up = seed.live ? (seed.live.ok ? `Up, answering with HTTP ${seed.live.status}` : `No answer${seed.live.error ? `: ${seed.live.error}` : ''}`)
          : seed.state === 'offline' ? 'Gone from DNS' : 'Not reached';
        const withheld = Object.entries(page.contactsWithheld || {}).map(([kind, n]) => plural(n, kind));
        live.append(facts([
          ['Right now', up],
          ['Shows', seed.title ? `“${seed.title}”` : ''],
          ['Scam kit', (seed.kits || []).map((k) => k.name).join(', ')],
          ['Pretends to be', (seed.brands || []).filter((b) => !b.official && (b.inDomain || b.inTitle)).map((b) => b.name).join(', ')],
          ['Link preview claims', page.spoofedHost],
          ['Asks for', [page.forms && page.forms.passwordFields ? 'a password' : '', page.forms && page.forms.cardFields ? 'card details' : ''].filter(Boolean).join(' and ')],
          ['Sends forms to', ((page.forms && page.forms.actionHosts) || []).map((h) => h.replace(/\./g, '[.]')).join(', ')],
          ['Listed on', (seed.blocklists || []).map((b) => b.name).join(', ')],
          ['Registered', [reg.created && dayYear(reg.created), reg.registrar && `through ${reg.registrar}`].filter(Boolean).join(' ')],
          ['Report abuse to', reg.abuseEmail],
          ['Hosted', net.shared ? `Behind ${net.shared}, so the real server is hidden` : [net.country && label(net.country), net.asnName].filter(Boolean).join(', ')],
          ['On the page', withheld.length ? `${withheld.join(', ')} (not shown here)` : ''],
        ]));
        const why = (seed.risk.signals || []).map((s) => s.label);
        if (why.length) { live.append(el('p', 'Why it scores what it does:', 'sr-home-label')); live.append(bullets(why)); }
        const code = (seed.findings || []).map((f) => `${f.label}${f.hidden ? ' (hidden in encoded script)' : ''}`);
        if (code.length) { live.append(el('p', 'What its code does:', 'sr-home-label')); live.append(bullets(code)); }
        if (state.live.partial) live.append(el('p', 'The visit ran out of time before every source answered, so some facts may be missing.', 'sr-note'));
        const map = el('a', 'Map the sites linked to it', 'btn btn-ghost btn-sm');
        map.href = `/scam-radar/map/?url=${encodeURIComponent(verdict.url)}`;
        live.append(map);
      }
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

  let checkRun = 0;
  const runCheck = async (raw, scroll) => {
    const out = $('#sr-check-result');
    const input = $('#sr-check-input');
    const core = window.ScamFinderCore;
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
    renderCheck(verdict, { radar, live: api ? 'loading' : 'none' });
    if (!api) return;
    const live = await fetch(`${API}?url=${encodeURIComponent(verdict.url)}`).then((r) => r.json()).catch(() => null);
    if (run !== checkRun) return;
    renderCheck(verdict, { radar, live: live || { error: 'The visit could not be finished. Try again in a minute.' } });
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

  guessCountry().then((cc) => { home = cc; if (data) draw(); });
  start();
  setInterval(poll, REFRESH_MS);
  setInterval(tick, 1000);
  setInterval(tickTimes, 30000);
  const preset = new URLSearchParams(location.search).get('check');
  if (preset) runCheck(preset, true);
})();
