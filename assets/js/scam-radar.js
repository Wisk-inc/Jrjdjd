/* Scam Radar: draws the latest scan, which a scheduled job publishes every few hours.
   - Data: the newest of the published snapshot (scam-radar-data branch) and the copy on this site.
   - Checks for a new scan every minute; the "updated ... ago" line ticks every second.
   - "Your country" is guessed from the device's time zone, on the device. Nothing is sent anywhere.
   Every value from the data goes in through textContent, never as HTML. */
(() => {
  'use strict';
  const SOURCES = [
    'https://raw.githubusercontent.com/Wisk-inc/Jrjdjd/scam-radar-data/scam-radar.json',
    '/assets/data/scam-radar.json',
  ];
  const REFRESH_MS = 60 * 1000;
  const STALE_HOURS = 8;
  const $ = (sel) => document.querySelector(sel);
  const el = (tag, text, cls) => {
    const node = document.createElement(tag);
    if (text !== undefined && text !== null) node.textContent = String(text);
    if (cls) node.className = cls;
    return node;
  };
  const num = (n) => (typeof n === 'number' ? n.toLocaleString('en') : '–');
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
    if (!t) return null;
    let s = Math.max(0, Math.floor((Date.now() - t) / 1000));
    const h = Math.floor(s / 3600); s -= h * 3600;
    const m = Math.floor(s / 60); s -= m * 60;
    if (h >= 48) return `${Math.round(h / 24)} days ago`;
    if (h) return `${h} h ${m} min ago`;
    if (m) return `${m} min ${s} s ago`;
    return `${s} s ago`;
  };
  const day = (iso) => {
    const t = Date.parse(iso);
    return t ? new Date(t).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) : '';
  };
  const store = {
    get(key) { try { return window.localStorage.getItem(key); } catch { return null; } },
    set(key, value) { try { window.localStorage.setItem(key, value); } catch { /* private mode */ } },
  };

  let data = null;
  let home = null; // the visitor's country
  const WAITING = 'Waiting for the first scan.';
  const scanned = () => Boolean(data && data.generated); // false while only the empty placeholder exists

  // ---------------------------------------------------------------- the visitor's country
  const guessCountry = async () => {
    const saved = store.get('scam-radar-country');
    if (isCC(saved)) return saved;
    try {
      const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
      const zones = await fetch('/assets/data/timezones.json').then((r) => r.json());
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
    const listed = new Set(Object.keys(data.byCountry || {}));
    if (home) listed.add(home);
    const options = [...listed].sort((a, b) => countryName(a).localeCompare(countryName(b)));
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

  const drawHome = () => {
    const cc = $('#sr-country').value || home;
    const title = $('#sr-home-title');
    const body = $('#sr-home-body');
    body.replaceChildren();
    if (!isCC(cc)) {
      title.textContent = 'Scams aimed at your country';
      body.append(el('p', 'Choose your country to see the scams aimed at it.', 'sr-note'));
      return;
    }
    const entry = (data.byCountry || {})[cc];
    title.textContent = `Scams aimed at ${inSentence(cc)}`;
    if (!scanned()) {
      body.append(el('p', `The first scan hasn't finished yet. The scams aimed at ${inSentence(cc)} will show here when it does.`, 'sr-note'));
      return;
    }
    if (!entry) {
      body.append(el('p', `No live, high-risk scam site aimed at ${inSentence(cc)} was found in the latest scan. That doesn't mean there are none: scams that reach people by text message or social media often never show up in a scan.`, 'sr-note'));
      return;
    }
    const top = el('p', null, 'sr-home-count');
    top.append(el('strong', num(entry.live)), el('span', ` live scam site${entry.live === 1 ? '' : 's'} aimed at ${inSentence(cc)} right now`));
    body.append(top);
    if ((entry.brands || []).length) {
      body.append(el('p', 'Brands they pretend to be:', 'sr-home-label'));
      const list = el('ul', null, 'sr-chips');
      entry.brands.forEach((b) => list.append(el('li', `${b.name} · ${b.live}`)));
      body.append(list);
    }
    const sites = (data.named || []).filter((r) => (r.targets || []).includes(cc)).slice(0, 10);
    if (sites.length) {
      body.append(el('p', 'Named on strong evidence (don’t visit these):', 'sr-home-label'));
      const list = el('ul', null, 'sr-downs');
      sites.forEach((r) => {
        const li = el('li');
        li.append(el('span', r.domain, 'sr-domain'));
        const why = [r.impersonates?.[0] && `pretends to be ${r.impersonates[0]}`, r.kit && `scam kit: ${r.kit}`, ...(r.listedBy || []).map((l) => `on a ${l}`)].filter(Boolean);
        li.append(el('span', why.length ? `  ${why.join('; ')}` : ''));
        list.append(li);
      });
      body.append(list);
    }
  };

  // ---------------------------------------------------------------- map and country table
  const shadeMap = (view) => {
    const rows = data[view] || [];
    const counts = new Map(rows.map((r) => [r.country, r.live]));
    const max = Math.max(1, ...rows.map((r) => r.live));
    document.querySelectorAll('.sr-map path').forEach((p) => {
      const title = p.querySelector('title');
      if (title && !p.dataset.name) p.dataset.name = title.textContent;
      const n = counts.get(p.dataset.cc) || 0;
      const level = n ? Math.min(5, 1 + Math.floor((4 * Math.log(n + 1)) / Math.log(max + 1))) : 0;
      p.setAttribute('data-level', String(level));
      if (p.dataset.cc === home) p.setAttribute('data-home', ''); else p.removeAttribute('data-home');
      if (title) title.textContent = `${p.dataset.name}: ${n} live scam site${n === 1 ? '' : 's'}`;
    });
    $('#sr-map-note').textContent = view === 'hosts'
      ? 'Shaded by where the live scam sites are hosted. Sites behind shared networks such as Cloudflare are left out, because their real server is hidden.'
      : 'Shaded by how many live, high-risk scam sites are aimed at each country: by the brand they impersonate, the currency or flag in their title, or their language. Your country has an outline.';
    const body = $('#sr-countries tbody');
    body.replaceChildren();
    if (!rows.length) {
      const tr = el('tr'); const td = el('td', scanned() ? 'None in the latest scan.' : WAITING); td.colSpan = 3; tr.append(td); body.append(tr);
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

  // ---------------------------------------------------------------- leaderboard
  const drawBoard = () => {
    const boards = data.leaderboards || {};
    const make = (id, rows, name) => {
      const list = $(`#${id}`);
      list.replaceChildren();
      if (!rows || !rows.length) { list.append(el('li', scanned() ? 'Nothing yet.' : WAITING, 'sr-empty')); return; }
      const max = Math.max(1, ...rows.map((r) => r.live));
      rows.slice(0, 15).forEach((r, i) => {
        const li = el('li');
        li.append(el('span', String(i + 1), 'sr-rank'));
        const who = el('span', null, 'sr-who');
        who.append(el('b', name(r)));
        if (r.country && id !== 'sr-lb-countries') who.append(el('small', label(r.country)));
        li.append(who, el('span', num(r.live), 'sr-count'));
        const meter = el('span', null, 'sr-bar'); meter.style.setProperty('--w', `${Math.round((100 * r.live) / max)}%`);
        li.append(meter);
        list.append(li);
      });
    };
    make('sr-lb-countries', boards.countries, (r) => label(r.country));
    make('sr-lb-brands', boards.brands, (r) => r.name);
    make('sr-lb-kits', boards.kits, (r) => r.name);
    make('sr-lb-networks', boards.networks, (r) => r.name);
  };

  // ---------------------------------------------------------------- named sites and takedowns
  const drawNamed = () => {
    const body = $('#sr-named tbody');
    body.replaceChildren();
    const rows = data.named || [];
    if (!rows.length) {
      const tr = el('tr'); const td = el('td', scanned() ? 'No live site met the bar in the latest scan.' : WAITING); td.colSpan = 5; tr.append(td); body.append(tr);
      return;
    }
    rows.forEach((r) => {
      const tr = el('tr');
      tr.append(el('td', r.domain, 'sr-domain'));
      tr.append(el('td', (r.targets || []).map(label).join(', ') || '–'));
      const evidence = [];
      if (r.kit) evidence.push(`Scam kit: ${r.kit}`);
      (r.listedBy || []).forEach((l) => evidence.push(`On a ${l}`));
      tr.append(el('td', evidence.join('; ') || '–'));
      tr.append(el('td', (r.impersonates || []).join(', ') || (r.lure ? `Lure: ${r.lure}` : '–')));
      tr.append(el('td', day(r.firstSeen)));
      body.append(tr);
    });
  };

  const drawDowns = () => {
    const list = $('#sr-downs');
    list.replaceChildren();
    const rows = data.takedowns || [];
    if (!rows.length) { list.append(el('li', scanned() ? 'None recorded this week yet.' : WAITING)); return; }
    rows.forEach((r) => {
      const li = el('li');
      li.append(el('span', r.domain, 'sr-domain'));
      const where = (r.targets || []).map(inSentence).join(', ');
      li.append(el('span', `  ${day(r.at)}${r.reason ? `, ${r.reason}` : ''}${where ? ` (aimed at ${where})` : ''}`));
      list.append(li);
    });
  };

  // ---------------------------------------------------------------- status, ticking every second
  const tick = () => {
    if (!data) return;
    const status = $('#sr-status');
    const age = $('#sr-age');
    if (!data.generated) {
      status.textContent = 'The first scan has not finished yet. This page checks every minute and fills in as soon as it does.';
      age.textContent = 'Starting up';
      return;
    }
    const hours = (Date.now() - Date.parse(data.generated)) / 3600000;
    status.textContent = `Last scan published ${since(data.generated)}, after ${num(data.scanCycles)} scan cycles. ` +
      (hours > STALE_HOURS ? 'That is older than it should be: the scheduled scan may have stopped.' : 'This page checks for a new one every minute.');
    age.textContent = hours > STALE_HOURS ? 'Data out of date' : `Updated ${since(data.generated)}`;
  };

  const draw = () => {
    document.querySelectorAll('#sr-stats dd').forEach((dd) => { dd.textContent = scanned() ? num((data.totals || {})[dd.dataset.k]) : '–'; });
    fillPicker();
    drawHome();
    shadeMap(document.querySelector('input[name="sr-view"]:checked')?.value || 'targets');
    drawBoard();
    drawNamed();
    drawDowns();
    tick();
  };

  // ---------------------------------------------------------------- loading
  const load = async () => {
    const stamp = Math.floor(Date.now() / 60000);
    const results = await Promise.all(SOURCES.map((url) =>
      fetch(url.startsWith('http') ? `${url}?t=${stamp}` : url, { cache: 'no-cache' })
        .then((r) => (r.ok ? r.json() : null)).catch(() => null)));
    const fresh = results.filter((d) => d && typeof d === 'object')
      .sort((a, b) => (Date.parse(b.generated) || 0) - (Date.parse(a.generated) || 0))[0];
    if (!fresh) {
      if (!data) $('#sr-status').textContent = 'The latest scan could not be loaded. This page will try again in a minute.';
      return;
    }
    if (data && data.generated === fresh.generated) return;
    data = fresh;
    draw();
  };

  document.querySelectorAll('input[name="sr-view"]').forEach((input) =>
    input.addEventListener('change', () => data && shadeMap(input.value)));
  $('#sr-country').addEventListener('change', (event) => {
    const cc = event.target.value;
    if (isCC(cc)) { home = cc; store.set('scam-radar-country', cc); }
    if (data) { drawHome(); shadeMap(document.querySelector('input[name="sr-view"]:checked')?.value || 'targets'); }
  });

  guessCountry().then((cc) => { home = cc; if (data) draw(); }).finally(() => load());
  setInterval(load, REFRESH_MS);
  setInterval(tick, 1000);
})();
