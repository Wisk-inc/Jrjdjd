/* CorX Labs — /benchmarks/
   Progressive enhancement over pages that are already complete without it.

   The leaderboard is server-rendered and sorts itself by moving existing rows,
   so it never re-fetches or re-renders; the compare tool is the only part that
   loads data, because its URL is the state and a crawler is told to skip it
   (robots.txt disallows query strings — the static head-to-head pages carry
   that content instead). */
(function () {
  'use strict';

  var MAX_COMPARE = 4;
  var DATA_URL = '/assets/data/models.json';

  function $(sel, root) { return (root || document).querySelector(sel); }
  function $$(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }
  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /* ======================================================================
     Formatting — kept identical to tools/bm_common.py so a value rendered
     by the tool and the same value rendered into a static page match.
     ====================================================================== */
  function fmtTokens(n) {
    if (!n) return null;
    if (n >= 1e6) { var m = n / 1e6; return (m < 10 ? +m.toFixed(1) : Math.round(m)) + 'M'; }
    if (n >= 1e3) { var k = n / 1e3; return (k < 10 ? +k.toFixed(1) : Math.round(k)) + 'K'; }
    return String(n);
  }
  function fmtPrice(p) {
    if (p === null || p === undefined) return null;
    if (p === 0) return '$0';
    if (p < 0.01) return '$' + p.toFixed(4);
    if (p < 1) return '$' + (((p * 100) % 1) ? p.toFixed(3) : p.toFixed(2));
    return '$' + p.toFixed(2);
  }
  function fmtScore(bench, v) {
    if (v === null || v === undefined) return null;
    return bench.unit === 'elo' ? String(v) : v + '%';
  }
  function scorePct(bench, v) {
    if (v === null || v === undefined) return 0;
    if (bench.unit === 'elo') return Math.max(0, Math.min(1, (v - 1000) / 500));
    return Math.max(0, Math.min(1, v / 100));
  }
  function modality(list) {
    var names = { text: 'Text', image: 'Image', audio: 'Audio', video: 'Video' };
    var order = ['text', 'image', 'audio', 'video'];
    var got = order.filter(function (x) { return (list || []).indexOf(x) > -1; });
    return got.length ? got.map(function (x) { return names[x]; }).join(', ') : null;
  }
  function nil(v) { return (v === null || v === undefined || v === '') ? '<span class="bm-nil">Not reported</span>' : esc(v); }
  function paramsLabel(m) {
    if (!m.params) return null;
    return m.active ? m.params + ' total / ' + m.active + ' active' : m.params;
  }
  function archLabel(m) { return m.arch || (m.params ? 'Dense transformer' : null); }

  /* ======================================================================
     Leaderboard
     ====================================================================== */
  function initLeaderboard() {
    var table = $('#bm-leaderboard');
    if (!table) return;

    var tbody = $('tbody', table);
    var rows = $$('tbody > tr', table);
    var q = $('#bm-q');
    var companySel = $('#bm-company');
    var sortSel = $('#bm-sort');
    var chips = { open: $('#bm-open'), reason: $('#bm-reason'), vision: $('#bm-vision') };
    var count = $('#bm-count');
    var total = rows.length;

    var empty = document.createElement('tr');
    empty.innerHTML = '<td colspan="11"><div class="bm-empty"><strong>Nothing matches that</strong>'
      + 'Try a shorter search, or clear the filters.</div></td>';
    empty.hidden = true;
    tbody.appendChild(empty);

    /* Missing values sort last in both directions. A model that never
       reported a benchmark is not the worst at it — it is unknown — so it
       must never occupy the bottom of an ascending sort as if it scored 0. */
    function cmp(key, kind, dir) {
      return function (a, b) {
        var va = a.dataset[key], vb = b.dataset[key];
        var na = va === '' || va === undefined, nb = vb === '' || vb === undefined;
        if (na && nb) return a.dataset.name.localeCompare(b.dataset.name);
        if (na) return 1;
        if (nb) return -1;
        var r;
        if (kind === 'num') r = parseFloat(va) - parseFloat(vb);
        else r = String(va).localeCompare(String(vb));
        if (r === 0) return a.dataset.name.localeCompare(b.dataset.name);
        return dir === 'asc' ? r : -r;
      };
    }

    var sortKey = 'gpqa';
    var sortKind = 'num';
    var sortDir = 'desc';

    function applySort() {
      var sorted = rows.slice().sort(cmp(sortKey, sortKind, sortDir));
      var frag = document.createDocumentFragment();
      sorted.forEach(function (r) { frag.appendChild(r); });
      tbody.insertBefore(frag, empty);
      $$('th[aria-sort]', table).forEach(function (th) {
        th.setAttribute('aria-sort', th.dataset.sort === sortKey
          ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none');
      });
    }

    function applyFilter() {
      var text = (q && q.value || '').trim().toLowerCase();
      var co = companySel ? companySel.value : '';
      var shown = 0;
      rows.forEach(function (r) {
        var d = r.dataset;
        var ok = true;
        if (text) {
          ok = d.name.indexOf(text) > -1 || d['companyName'].indexOf(text) > -1
            || d.slug.indexOf(text) > -1 || d.lic.indexOf(text) > -1;
        }
        if (ok && co) ok = d.company === co;
        if (ok && chips.open && chips.open.checked) ok = d.open === '1';
        if (ok && chips.reason && chips.reason.checked) ok = d.reason === '1';
        if (ok && chips.vision && chips.vision.checked) ok = d.vision === '1';
        r.hidden = !ok;
        if (ok) shown++;
      });
      empty.hidden = shown !== 0;
      if (count) {
        count.innerHTML = shown === total
          ? 'Showing <strong>' + total + '</strong> of ' + total + ' models'
          : 'Showing <strong>' + shown + '</strong> of ' + total + ' models';
      }
    }

    var timer;
    function debounced() { clearTimeout(timer); timer = setTimeout(applyFilter, 110); }

    if (q) q.addEventListener('input', debounced);
    if (companySel) companySel.addEventListener('change', applyFilter);
    Object.keys(chips).forEach(function (k) {
      if (chips[k]) chips[k].addEventListener('change', applyFilter);
    });
    if (sortSel) {
      sortSel.addEventListener('change', function () {
        sortKey = sortSel.value;
        sortKind = (sortKey === 'name' || sortKey === 'lic' || sortKey === 'company'
          || sortKey === 'rel') ? 'text' : 'num';
        sortDir = (sortKey === 'name' || sortKey === 'pin' || sortKey === 'pout') ? 'asc' : 'desc';
        applySort();
      });
    }

    $$('th[aria-sort] button', table).forEach(function (btn) {
      btn.addEventListener('click', function () {
        var th = btn.closest('th');
        var key = th.dataset.sort;
        if (key === sortKey) {
          sortDir = sortDir === 'asc' ? 'desc' : 'asc';
        } else {
          sortKey = key;
          sortKind = th.dataset.kind;
          sortDir = sortKind === 'num' ? 'desc' : 'asc';
        }
        if (sortSel) sortSel.value = ($$('option', sortSel).some(function (o) {
          return o.value === key;
        })) ? key : sortSel.value;
        applySort();
      });
    });

    /* ---- compare tray ---- */
    var tray = $('#bm-tray');
    var trayN = $('#bm-tray-n');
    var trayList = $('#bm-tray-list');
    var trayGo = $('#bm-tray-go');
    var trayClear = $('#bm-tray-clear');
    var picked = [];

    function paintTray() {
      if (!tray) return;
      tray.hidden = picked.length === 0;
      if (trayN) trayN.textContent = String(picked.length);
      if (trayList) {
        trayList.innerHTML = picked.map(function (s) {
          var row = rows.filter(function (r) { return r.dataset.slug === s; })[0];
          var name = row ? $('.name', row).textContent : s;
          return '<span>' + esc(name) + '</span>';
        }).join('');
      }
      if (trayGo) {
        trayGo.href = '/benchmarks/compare/?m=' + picked.join(',');
        trayGo.setAttribute('aria-disabled', picked.length < 2 ? 'true' : 'false');
        trayGo.style.opacity = picked.length < 2 ? '.5' : '';
        trayGo.style.pointerEvents = picked.length < 2 ? 'none' : '';
      }
    }

    $$('.bm-pick-input', table).forEach(function (box) {
      box.addEventListener('change', function () {
        var slug = box.value;
        if (box.checked) {
          if (picked.length >= MAX_COMPARE) {
            box.checked = false;
            if (count) {
              count.innerHTML = 'You can compare up to <strong>' + MAX_COMPARE
                + '</strong> models at once. Clear one first.';
              setTimeout(applyFilter, 2600);
            }
            return;
          }
          picked.push(slug);
        } else {
          picked = picked.filter(function (s) { return s !== slug; });
        }
        paintTray();
      });
    });

    if (trayClear) {
      trayClear.addEventListener('click', function () {
        picked = [];
        $$('.bm-pick-input', table).forEach(function (b) { b.checked = false; });
        paintTray();
      });
    }

    applySort();
    applyFilter();
  }

  /* ======================================================================
     Compare tool
     ====================================================================== */
  function initCompare() {
    var root = $('#bm-compare-root');
    if (!root) return;

    var addBtn = $('#bm-add');
    var panel = $('#bm-picker-panel');
    var pickerQ = $('#bm-picker-q');
    var list = $('#bm-picker-list');
    var resetBtn = $('#bm-reset');
    var copyBtn = $('#bm-copy');

    var DATA = null;
    var chosen = [];

    function bySlug(s) {
      for (var i = 0; i < DATA.models.length; i++) {
        if (DATA.models[i].slug === s) return DATA.models[i];
      }
      return null;
    }

    function readUrl() {
      var m = new URLSearchParams(location.search).get('m');
      return m ? m.split(',').map(function (s) { return s.trim(); }).filter(Boolean).slice(0, MAX_COMPARE) : [];
    }

    function writeUrl() {
      var url = location.pathname + (chosen.length ? '?m=' + chosen.join(',') : '');
      history.replaceState(null, '', url);
    }

    /* ---- rendering ---- */
    function colHead(m) {
      var co = DATA.companies[m.company];
      return '<th scope="col"><span class="bm-colhead"><span class="top">'
        + '<span class="logo-tile"><img class="logo-mark" src="' + co.logo
        + '" width="24" height="24" alt="" aria-hidden="true" decoding="async"></span>'
        + '<span><a class="title" href="' + m.url + '">' + esc(m.name) + '</a>'
        + '<span class="maker">' + esc(co.name) + '</span></span></span>'
        + '<button type="button" class="drop" data-drop="' + esc(m.slug)
        + '">Remove</button></span></th>';
    }

    function sectionRow(label, n) {
      return '<tr><th scope="row" style="background:var(--paper-sunk);color:var(--espresso);'
        + 'font-weight:600">' + esc(label) + '</th>'
        + new Array(n + 1).join('<td style="background:var(--paper-sunk)"></td>') + '</tr>';
    }

    function labelCell(label, hint) {
      return '<th scope="row">' + esc(label)
        + (hint ? '<span class="hint">' + esc(hint) + '</span>' : '') + '</th>';
    }

    var SPEC = [
      ['Maker', 'Who built it', function (m) { return DATA.companies[m.company].name; }],
      ['Released', null, function (m) { return m.rel || null; }],
      ['Parameters', 'Total, and active per token for a mixture of experts', paramsLabel],
      ['Architecture', null, archLabel],
      ['Context window', 'How much can go in at once',
        function (m) { return m.ctx ? m.ctx.toLocaleString('en-US') + ' tokens' : null; }],
      ['Max output', null,
        function (m) { return m.out ? m.out.toLocaleString('en-US') + ' tokens' : null; }],
      ['Input', null, function (m) { return modality(m.inp); }],
      ['Reasoning', 'Spends extra tokens thinking before it answers',
        function (m) { return m.reason ? 'Yes' : ('reason' in m ? 'No' : null); }],
      ['Tool calling', null, function (m) { return m.tools ? 'Yes' : ('tools' in m ? 'No' : null); }],
      ['Knowledge cutoff', null, function (m) { return m.cut || null; }],
      ['Licence', null, function (m) { return m.licence || null; }],
      ['Open weights', 'Can you download and run it yourself',
        function (m) { return m.open ? 'Yes' : 'No'; }]
    ];

    var PRICE = [
      ['Input price', 'USD per million tokens in', 'pin', false],
      ['Output price', 'USD per million tokens out', 'pout', false],
      ['Cached input', null, 'pcache', false],
      ['Blended 3:1', 'A 3-in-to-1-out million-token mix — a fairer single number than input price alone',
        'blended', true]
    ];

    function benchCell(bench, v, best) {
      if (v === null || v === undefined) return '<span class="bm-nil">Not reported</span>';
      return '<span class="bm-bar' + (best ? ' is-best' : '') + '">'
        + '<span class="val">' + esc(fmtScore(bench, v))
        + (best ? '<span class="bm-best-tag">Best</span>' : '') + '</span>'
        + '<span class="track"><span class="fill" style="width:'
        + (scorePct(bench, v) * 100).toFixed(1) + '%"></span></span></span>';
    }

    /* ---- category scorecard ----
       Mirrors tools/bm_common.py: a category averages only the benchmarks
       EVERY compared model reports, so nobody is credited for a test the
       others did not run. Units are consistent within a group, so the
       average never mixes a percentage with an Elo. */
    var CATEGORY_ORDER = ['Reasoning', 'Maths', 'Coding', 'Knowledge', 'Multimodal',
      'Instruction following', 'Human preference'];

    function fmtCategory(unit, v) {
      if (v === null || v === undefined) return null;
      return unit === 'elo' ? String(Math.round(v)) : v.toFixed(1) + '%';
    }

    function categoryRows(models) {
      return CATEGORY_ORDER.map(function (group) {
        var keys = DATA.benchmarks.filter(function (b) { return b.group === group; });
        var shared = keys.filter(function (b) {
          return models.every(function (m) {
            var v = (m.b || {})[b.key];
            return v !== null && v !== undefined;
          });
        });
        if (!shared.length) {
          var partial = keys.some(function (b) {
            return models.some(function (m) {
              var v = (m.b || {})[b.key];
              return v !== null && v !== undefined;
            });
          });
          return { group: group, shared: [], values: models.map(function () { return null; }),
                   best: null, unit: null, partial: partial };
        }
        var values = models.map(function (m) {
          return shared.reduce(function (t, b) { return t + m.b[b.key]; }, 0) / shared.length;
        });
        var spread = Math.max.apply(null, values) - Math.min.apply(null, values);
        return {
          group: group, shared: shared, values: values, unit: shared[0].unit,
          best: (models.length > 1 && spread > 0.05) ? Math.max.apply(null, values) : null,
          spread: spread, partial: false
        };
      });
    }

    function scorecard(models) {
      var rows = categoryRows(models);
      var scored = rows.filter(function (r) { return r.best !== null; });
      var wins = models.map(function () { return 0; });
      scored.forEach(function (r) { wins[r.values.indexOf(r.best)]++; });

      var head = '<th scope="col">Category</th>' + models.map(function (m) {
        return '<th scope="col" class="bm-sc-model"><span><img class="logo-mark" src="'
          + DATA.companies[m.company].logo + '" width="18" height="18" alt="" aria-hidden="true" '
          + 'decoding="async"><span class="n">' + esc(m.name) + '</span></span></th>';
      }).join('') + '<th scope="col">Better at this</th>';

      var body = rows.map(function (r) {
        var label = '<th scope="row"><span class="g">' + esc(r.group) + '</span><span class="t">'
          + esc(r.shared.length ? r.shared.map(function (b) { return b.name; }).join(', ')
              : (r.partial ? 'Only one model reports this' : 'Neither model reports this'))
          + '</span></th>';
        if (!r.shared.length) {
          return '<tr>' + label
            + models.map(function () { return '<td class="bm-sc-none">&mdash;</td>'; }).join('')
            + '<td class="bm-sc-none">Not comparable</td></tr>';
        }
        var cells = r.values.map(function (v) {
          var win = r.best !== null && v === r.best;
          return '<td class="bm-sc-val' + (win ? ' is-win' : '') + '">'
            + esc(fmtCategory(r.unit, v))
            + (win ? '<i class="bm-sc-tick" aria-hidden="true"></i>' : '') + '</td>';
        }).join('');
        var verdict = r.best === null
          ? '<td class="bm-sc-who is-tie">Tied</td>'
          : '<td class="bm-sc-who"><strong>' + esc(models[r.values.indexOf(r.best)].name)
            + '</strong><span class="d">+'
            + (r.unit === 'elo' ? Math.round(r.spread) : r.spread.toFixed(1)) + '</span></td>';
        return '<tr>' + label + cells + verdict + '</tr>';
      }).join('');

      var foot;
      if (scored.length) {
        var top = Math.max.apply(null, wins);
        var leaders = models.filter(function (m, i) { return wins[i] === top && top > 0; });
        foot = '<tr><th scope="row"><span class="g">Categories won</span><span class="t">Out of '
          + scored.length + ' comparable</span></th>'
          + wins.map(function (w) {
              return '<td class="bm-sc-val' + (w === top && top > 0 ? ' is-win' : '') + '">'
                + w + '</td>';
            }).join('')
          + '<td class="bm-sc-who"><strong>'
          + (leaders.length === 1 ? esc(leaders[0].name)
              : 'Split &mdash; ' + leaders.map(function (m) { return esc(m.name); }).join(' and '))
          + '</strong></td></tr>';
      } else {
        foot = '<tr><th scope="row"><span class="g">Categories won</span></th>'
          + '<td class="bm-sc-none" colspan="' + (models.length + 1)
          + '">No category has a test every model here reports</td></tr>';
      }

      return '<div class="bm-sc-wrap"><table class="bm-scorecard">'
        + '<caption class="visually-hidden">Which model scores higher in each capability '
        + 'category, averaged over the benchmarks all of them report.</caption>'
        + '<thead><tr>' + head + '</tr></thead><tbody>' + body + '</tbody>'
        + '<tfoot>' + foot + '</tfoot></table></div>'
        + '<p class="bm-sc-note">Each category averages only the benchmarks <strong>every</strong> '
        + 'model here reports, so no one is credited for a test the others did not run. '
        + 'A category with no shared test is marked <em>Not comparable</em> rather than '
        + 'guessed at.</p>';
    }

    function render() {
      if (!chosen.length) {
        root.innerHTML = '<div class="bm-empty" style="border:1px dashed var(--line-strong);'
          + 'border-radius:var(--r-md)"><strong>Nothing selected yet</strong>'
          + 'Press <em>Add a model</em> to start, or pick one of the ready-made '
          + 'comparisons below.</div>';
        return;
      }

      var models = chosen.map(bySlug).filter(Boolean);
      if (!models.length) { root.innerHTML = ''; return; }

      var html = '';
      if (models.length > 1) {
        html += '<h2 class="bm-sc-title">Which is better at what</h2>'
          + scorecard(models)
          + '<h2 class="bm-sc-title" style="margin-top:38px">Row by row</h2>';
      }

      html += '<div class="bm-compare-wrap"><table class="bm-compare"><thead><tr>'
        + '<th class="bm-corner"><span class="visually-hidden">Attribute</span></th>'
        + models.map(colHead).join('') + '</tr></thead><tbody>';

      html += sectionRow('Specification', models.length);
      SPEC.forEach(function (row) {
        var vals = models.map(row[2]);
        if (vals.every(function (v) { return v === null || v === undefined; })) return;
        html += '<tr>' + labelCell(row[0], row[1]) + vals.map(function (v) {
          return '<td' + (v ? '' : ' class="is-nil"') + '>' + nil(v) + '</td>';
        }).join('') + '</tr>';
      });

      html += sectionRow('Price', models.length);
      PRICE.forEach(function (row) {
        var nums = models.map(function (m) {
          var v = m[row[2]];
          return (v === undefined || v === null) ? null : v;
        });
        if (nums.every(function (v) { return v === null; })) return;
        var known = nums.filter(function (v) { return v !== null; });
        var best = (row[3] && known.length > 1 && new Set(known).size > 1)
          ? Math.min.apply(null, known) : null;
        html += '<tr>' + labelCell(row[0], row[1]) + nums.map(function (v) {
          var win = best !== null && v === best;
          var txt = fmtPrice(v);
          return '<td' + (win ? ' class="bm-best"' : (txt ? '' : ' class="is-nil"')) + '>'
            + nil(txt) + (win ? '<span class="bm-best-tag">Cheapest</span>' : '') + '</td>';
        }).join('') + '</tr>';
      });
      if (models.some(function (m) { return m.hosted_price; })) {
        html += '<tr>' + labelCell('Price note', null) + models.map(function (m) {
          return '<td style="font-size:.84rem;color:var(--muted)">' + (m.hosted_price
            ? 'Open weights — this is a representative hosting rate, not a first-party '
              + 'price. Running it yourself costs only hardware.'
            : 'First-party API rate.') + '</td>';
        }).join('') + '</tr>';
      }

      var benchRows = '';
      DATA.benchmarks.forEach(function (bench) {
        var vals = models.map(function (m) {
          var v = (m.b || {})[bench.key];
          return (v === undefined) ? null : v;
        });
        if (vals.every(function (v) { return v === null; })) return;
        var known = vals.filter(function (v) { return v !== null; });
        var best = (known.length > 1 && new Set(known).size > 1)
          ? Math.max.apply(null, known) : null;
        benchRows += '<tr><th scope="row"><a href="' + bench.url + '" style="color:inherit;'
          + 'text-decoration:underline;text-underline-offset:3px">' + esc(bench.name) + '</a>'
          + '<span class="hint">' + esc(bench.blurb) + '</span></th>'
          + vals.map(function (v) {
            return '<td>' + benchCell(bench, v, best !== null && v === best) + '</td>';
          }).join('') + '</tr>';
      });
      html += sectionRow('Published benchmarks', models.length);
      html += benchRows || ('<tr>' + labelCell('Scores', null) + models.map(function () {
        return '<td class="is-nil">No published figures</td>';
      }).join('') + '</tr>');

      html += '<tr>' + labelCell('Links', null) + models.map(function (m) {
        var bits = [];
        if (m.hf) {
          bits.push('<a href="https://huggingface.co/' + esc(m.hf) + '" rel="noopener" '
            + 'target="_blank" style="text-decoration:underline;text-underline-offset:3px">'
            + 'Hugging Face</a>');
        }
        bits.push('<a href="' + m.url + '" style="text-decoration:underline;'
          + 'text-underline-offset:3px">Full page</a>');
        return '<td style="font-size:.86rem">' + bits.join(' &middot; ') + '</td>';
      }).join('') + '</tr>';

      html += '<tr>' + labelCell('Row verified', null) + models.map(function (m) {
        return '<td style="font-size:.86rem;color:var(--muted)">' + esc(m.verified || '—')
          + '</td>';
      }).join('') + '</tr>';

      html += '</tbody></table></div>';

      // When this exact pair already has a dedicated page, say so — it is a
      // better destination than a query string nothing can link to.
      if (models.length === 2) {
        var a = models[0].slug, b = models[1].slug;
        var url = DATA.pairs[a + '|' + b] || DATA.pairs[b + '|' + a];
        if (url) {
          html += '<p style="margin-top:16px;font-size:.9rem;color:var(--muted)">'
            + 'There is a full write-up of this pairing at '
            + '<a href="' + url + '" style="color:var(--ink-strong);text-decoration:underline;'
            + 'text-underline-offset:3px">' + esc(models[0].name) + ' vs '
            + esc(models[1].name) + '</a>.</p>';
        }
      }

      root.innerHTML = html;

      $$('[data-drop]', root).forEach(function (btn) {
        btn.addEventListener('click', function () {
          chosen = chosen.filter(function (s) { return s !== btn.dataset.drop; });
          writeUrl();
          render();
          if (addBtn) addBtn.focus();
        });
      });
    }

    /* ---- picker ---- */
    var options = [];
    var activeIndex = -1;

    function paintOptions() {
      var text = (pickerQ.value || '').trim().toLowerCase();
      options = DATA.models.filter(function (m) {
        if (!text) return true;
        return m.name.toLowerCase().indexOf(text) > -1
          || DATA.companies[m.company].name.toLowerCase().indexOf(text) > -1
          || m.slug.indexOf(text) > -1;
      }).slice(0, 60);

      if (!options.length) {
        list.innerHTML = '<p class="bm-picker-none">No model matches that.</p>';
        return;
      }
      list.innerHTML = options.map(function (m, i) {
        var co = DATA.companies[m.company];
        var taken = chosen.indexOf(m.slug) > -1;
        return '<button type="button" class="bm-opt" role="option" aria-selected="false"'
          + (taken ? ' disabled' : '') + ' data-slug="' + esc(m.slug) + '" data-i="' + i + '">'
          + '<span class="logo-tile is-sm"><img class="logo-mark" src="' + co.logo
          + '" width="18" height="18" alt="" aria-hidden="true" loading="lazy" decoding="async"></span>'
          + '<span><span class="n">' + esc(m.name) + '</span>'
          + '<span class="s">' + esc(co.name) + (m.ctx ? ' &middot; ' + fmtTokens(m.ctx) + ' context' : '')
          + '</span></span></button>';
      }).join('');
      activeIndex = -1;
    }

    function highlight(i) {
      var btns = $$('.bm-opt', list);
      btns.forEach(function (b) { b.setAttribute('aria-selected', 'false'); });
      if (i < 0 || i >= btns.length) { activeIndex = -1; return; }
      activeIndex = i;
      btns[i].setAttribute('aria-selected', 'true');
      btns[i].scrollIntoView({ block: 'nearest' });
    }

    function openPanel() {
      if (chosen.length >= MAX_COMPARE) return;
      panel.hidden = false;
      addBtn.setAttribute('aria-expanded', 'true');
      pickerQ.value = '';
      paintOptions();
      pickerQ.focus();
    }
    function closePanel() {
      panel.hidden = true;
      addBtn.setAttribute('aria-expanded', 'false');
    }

    function choose(slug) {
      if (!slug || chosen.indexOf(slug) > -1 || chosen.length >= MAX_COMPARE) return;
      chosen.push(slug);
      writeUrl();
      render();
      closePanel();
      addBtn.disabled = chosen.length >= MAX_COMPARE;
      addBtn.textContent = chosen.length >= MAX_COMPARE
        ? 'Four is the maximum' : 'Add a model';
    }

    if (addBtn) {
      addBtn.addEventListener('click', function () {
        if (panel.hidden) openPanel(); else closePanel();
      });
    }
    if (pickerQ) pickerQ.addEventListener('input', paintOptions);
    if (list) {
      list.addEventListener('click', function (e) {
        var btn = e.target.closest('.bm-opt');
        if (btn && !btn.disabled) choose(btn.dataset.slug);
      });
    }
    if (panel) {
      panel.addEventListener('keydown', function (e) {
        var btns = $$('.bm-opt:not([disabled])', list);
        if (e.key === 'Escape') { closePanel(); addBtn.focus(); return; }
        if (e.key === 'ArrowDown') { e.preventDefault(); highlight(Math.min(activeIndex + 1, btns.length - 1)); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); highlight(Math.max(activeIndex - 1, 0)); }
        else if (e.key === 'Enter' && activeIndex > -1) {
          e.preventDefault();
          choose(btns[activeIndex].dataset.slug);
        }
      });
    }
    document.addEventListener('click', function (e) {
      if (panel && !panel.hidden && !e.target.closest('#bm-picker')) closePanel();
    });

    if (resetBtn) {
      resetBtn.addEventListener('click', function () {
        chosen = [];
        writeUrl();
        render();
        addBtn.disabled = false;
        addBtn.textContent = 'Add a model';
        addBtn.focus();
      });
    }
    if (copyBtn) {
      copyBtn.addEventListener('click', function () {
        var url = location.href;
        var done = function () {
          copyBtn.textContent = 'Copied';
          copyBtn.setAttribute('data-copied', 'true');
          setTimeout(function () {
            copyBtn.textContent = 'Copy link';
            copyBtn.removeAttribute('data-copied');
          }, 1800);
        };
        if (navigator.clipboard && window.isSecureContext) {
          navigator.clipboard.writeText(url).then(done).catch(function () {});
        } else {
          var ta = document.createElement('textarea');
          ta.value = url;
          ta.style.position = 'absolute';
          ta.style.left = '-9999px';
          document.body.appendChild(ta);
          ta.select();
          try { document.execCommand('copy'); done(); } catch (err) {}
          document.body.removeChild(ta);
        }
      });
    }

    root.innerHTML = '<div class="bm-empty">Loading the catalogue&hellip;</div>';
    fetch(DATA_URL, { credentials: 'omit' })
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then(function (data) {
        DATA = data;
        chosen = readUrl().filter(bySlug);
        addBtn.disabled = chosen.length >= MAX_COMPARE;
        render();
      })
      .catch(function () {
        root.innerHTML = '<div class="bm-empty"><strong>The catalogue did not load</strong>'
          + 'Reload the page, or use one of the ready-made comparisons below — those are '
          + 'complete pages and do not need this to work.</div>';
      });
  }

  initLeaderboard();
  initCompare();
})();
