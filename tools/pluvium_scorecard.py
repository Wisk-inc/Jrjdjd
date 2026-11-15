"""Pluvium scorecard: bar charts and a comparison table, as static HTML.

Numbers are copied from Pluvium's docs/OPERATIONAL_BENCHMARK.md (commit 272a0c3):
450 land cells of 8 km covering Jamaica, CMORPH truth, every system calibrated the
same causal way. Brier skill scores and ROC areas are shown as percentages, so
higher is better everywhere except CRPS, which is labelled lower-is-better.
Used by tools/build-pluvium-page.py.
"""
import html
from pathlib import Path

# key: (name, producer, icon file, kind)  kind: featured | blend | ref | other
SYSTEMS = {
    "pluvium": ("Pluvium", "CorX Labs", "pluvium", "featured"),
    "ens":     ("ENS", "ECMWF", "ens", "other"),
    "gefs":    ("GEFS", "NOAA", "gefs", "other"),
    "hres":    ("HRES", "ECMWF", "hres", "other"),
    "aifs":    ("AIFS", "ECMWF", "aifs", "other"),
    "gc":      ("GraphCast", "DeepMind · NOAA", "graphcast", "other"),  # Google DeepMind model, run by NOAA
    "gfs":     ("GFS", "NOAA", "gfs", "other"),
    "b6":      ("Blend of six", "All six", "blend6", "blend"),
    "b6p":     ("Blend + Pluvium", "Six + Pluvium", "blend6p", "blend"),
    "never":   ("Never rain", "Reference", "never", "ref"),
    "pblend":  ("Pluvium Blend", "CorX Labs", "pluvium", "featured"),
    "pnet":    ("Pluvium network", "CorX Labs", "pluvium", "featured"),
}
ORDER = ["pluvium", "ens", "gefs", "hres", "aifs", "gc", "gfs", "b6", "b6p", "never"]

# July-August 2025, logistic calibration (the frozen protocol). Days 1, 2, 3.
BSS1 = {"pluvium": (.127, .118, .052), "ens": (.056, .029, .014), "gefs": (.069, .091, .043),
        "hres": (.030, .011, -.001), "aifs": (.082, .069, .063), "gc": (.073, .064, .049),
        "gfs": (.087, .091, .058), "b6": (.090, .095, .061), "b6p": (.136, .134, .081),
        "never": (-.201, -.209, -.210)}
BSS10 = {"pluvium": (.066, .088, .092), "ens": (.047, .074, .088), "gefs": (.068, .068, .091),
         "hres": (.063, .072, .080), "aifs": (.077, .090, .093), "gc": (.074, .070, .082),
         "gfs": (.088, .035, .061), "b6": (.059, .038, .054), "b6p": (.047, .036, .038),
         "never": (.063, .061, .071)}
ROC1 = {"pluvium": .758, "ens": .669, "gefs": .702, "hres": .624, "aifs": .688, "gc": .701,
        "gfs": .725, "b6": .729, "b6p": .767}
ROC10 = {"pluvium": .712, "ens": .742, "gefs": .667, "hres": .585, "aifs": .570, "gc": .693,
         "gfs": .536, "b6": .726, "b6p": .766}
CRPS = {"pluvium": (.87, .89, .91), "ens": (1.45, 1.67, 1.68), "gefs": (1.80, 1.58, 1.60),
        "hres": (1.94, 2.41, 2.36), "aifs": (1.76, 1.92, 1.94), "gc": (1.83, 1.76, 1.73),
        "gfs": (2.42, 2.52, 2.56)}
# Rivals Pluvium beat with 95% confidence (moving-block bootstrap), July-August 2025
SIG1 = {0: {"ens", "hres", "aifs", "gc", "b6"}, 1: {"ens", "hres", "aifs", "gc"}, 2: {"ens", "hres"}}
SIG10 = {0: set(), 1: {"b6p"}, 2: set()}
# May-June 2025, isotonic calibration (the protocol fixed for that test). Days 1, 2, 3.
MAYJUN1 = {"pluvium": (-.032, -.034, .021), "ens": (.059, .022, -.014), "gefs": (.071, .067, .041),
           "hres": (.039, -.023, -.011), "aifs": (.070, .064, .051), "gc": (.082, .083, .066),
           "gfs": (.082, .074, .040), "b6": (.087, .094, .068), "b6p": (.046, .038, .078),
           "never": (-.212, -.209, -.204)}

ICON = '<img class="sc-mark{cls}" src="{src}" width="{w}" height="{w}" alt="" aria-hidden="true" loading="lazy" decoding="async">'


# Official producer logos win when present: drop ecmwf.svg / noaa.svg (or .png) into
# assets/img/logos/weather/official/ and rebuild. Until then each system has its own icon.
OFFICIAL_DIR = Path(__file__).resolve().parent.parent / "assets/img/logos/weather/official"
OFFICIAL_FOR = {"ens": "ecmwf", "hres": "ecmwf", "aifs": "ecmwf", "gefs": "noaa", "gfs": "noaa"}


CORX_LOGO = "/assets/img/logos/corx.4c986e8d.svg"   # the lab's mark, as on the benchmark pages


def icon_src(key):
    if key in ("pluvium", "pblend", "pnet"):
        return CORX_LOGO
    org = OFFICIAL_FOR.get(key)
    for ext in ("svg", "png", "webp"):
        if org and (OFFICIAL_DIR / f"{org}.{ext}").is_file():
            return f"/assets/img/logos/weather/official/{org}.{ext}"
    return f"/assets/img/logos/weather/{SYSTEMS[key][2]}.svg"


def icon(key, small=False):
    cls = (" is-sm" if small else "") + (" is-tile" if key in ("pluvium", "pblend", "pnet") else "")
    return ICON.format(cls=cls, src=icon_src(key), w=20 if small else 26)


def pct(v, digits=1):
    s = f"{abs(v) * 100:.{digits}f}%"
    return ("−" if v < 0 else "") + s


def nice_ticks(lo, hi):
    span = hi - lo
    step = next(s for s in (.01, .02, .025, .05, .1, .2) if span / s <= 6)
    import math
    start = math.floor(lo / step) * step
    end = math.ceil(hi / step) * step
    ticks, t = [], start
    while t <= end + 1e-9:
        ticks.append(round(t, 4)); t += step
    return ticks


def axis_pct(t):
    v = int(round(t * 100))
    return ("\u2212" if v < 0 else "") + f"{abs(v)}%"


def bar_chart(values, *, title, sub, note="", floor=None, axis_fmt=axis_pct,
              label=pct, dir_text="Higher is better"):
    """values: {key: value}. Sorted high to low; the reference is kept last.
    floor: the value bars grow from (0 for skill scores, 0.5 for ROC area)."""
    keys = sorted((k for k in values if SYSTEMS[k][3] != "ref"), key=lambda k: -values[k])
    keys += [k for k in values if SYSTEMS[k][3] == "ref"]
    base = 0.0 if floor is None else floor
    lo = min(min(values.values()), base)
    hi = max(max(values.values()), base)
    ticks = nice_ticks(lo, hi)
    lo, hi = ticks[0], ticks[-1]
    pos = lambda v: (v - lo) / (hi - lo) * 100            # % from the bottom of the plot
    top = max(values[k] for k in keys if SYSTEMS[k][3] != "ref")
    best = {k for k in keys if SYSTEMS[k][3] != "ref" and values[k] == top}
    top1 = max(values[k] for k in keys if SYSTEMS[k][3] in ("featured", "other"))
    single = {k for k in keys if SYSTEMS[k][3] in ("featured", "other") and values[k] == top1} - best
    if any(SYSTEMS[k][3] in ("featured", "other") for k in best):
        single = set()
    n = len(keys)
    axis = "".join(f'<span style="bottom:{pos(t):.2f}%">{axis_fmt(t)}</span>' for t in ticks)
    grid = "".join(f'<div class="sc-grid{" is-zero" if abs(t - base) < 1e-9 else ""}" style="bottom:{pos(t):.2f}%"></div>'
                   for t in ticks)
    cols, names = [], []
    for k in keys:
        v = values[k]; name, prod, _, kind = SYSTEMS[k]
        up = v >= base
        b = pos(base) if up else pos(v)
        h = abs(pos(v) - pos(base))
        cls = ["sc-col", "is-up" if up else "is-down"] + ([f"is-{kind}"] if kind != "other" else [])
        tag = ('<b class="sc-best">Best</b>' if k in best else
               '<b class="sc-best is-single">Best single</b>' if k in single else "")
        if up:
            val = f'<span class="sc-val">{tag}{label(v)}</span>'
        else:
            val = f'<span class="sc-val">{label(v)}</span>'
        cols.append(f'<div class="{" ".join(cls)}" style="--b:{b:.2f}%;--h:{h:.2f}%">'
                    f'<div class="sc-bar"></div>{val}</div>')
        names.append(f'<div class="sc-name{" is-featured" if kind == "featured" else ""}">{icon(k)}'
                     f'<b>{html.escape(name)}</b><small>{html.escape(prod)}</small></div>')
    aria = "; ".join(f"{SYSTEMS[k][0]} ({SYSTEMS[k][1]}) {label(values[k])}" for k in keys)
    return f"""<div class="sc-card" data-reveal>
          <div class="sc-head">
            <div><p class="sc-title">{title}</p><p class="sc-sub">{sub}</p></div>
            <span class="sc-dir"><span aria-hidden="true">&uarr;</span> {dir_text}</span>
          </div>
          <div class="sc-scroll">
            <div class="sc-chart" role="img" aria-label="{html.escape(title)}. {html.escape(aria)}.">
              <div class="sc-axis" aria-hidden="true">{axis}</div>
              <div class="sc-plot" aria-hidden="true">{grid}<div class="sc-bars" style="--n:{n}">{"".join(cols)}</div></div>
              <div class="sc-names" style="--n:{n}" aria-hidden="true">{"".join(names)}</div>
            </div>
          </div>
          {f'<p class="sc-note">{note}</p>' if note else ''}
        </div>"""


KEY = """<div class="sc-key" aria-hidden="true">
            <span><i class="is-featured"></i> Pluvium</span>
            <span><i class="is-blend"></i> Blends</span>
            <span><i></i> Operational systems</span>
            <span><i class="is-ref"></i> Reference: a forecast that never says rain</span>
          </div>"""


def day_tabs():
    panels = []
    for d in range(3):
        panels.append(f'<div class="sc-panel sc-p{d + 1}">' + bar_chart(
            {k: v[d] for k, v in BSS1.items()},
            title=f"Will it rain? Rain of at least 1&nbsp;mm, day {d + 1}",
            sub="Brier skill score against the climatology of the same weeks, as a percentage. "
                "0% is no better than climatology. Jamaica, July&ndash;August 2025.",
            note=["Pluvium is the best single system on day 1; only the blend that includes Pluvium scores higher.",
                  "Pluvium is the best single system on day 2; again only the blend that includes it scores higher.",
                  "Day 3 is closer: AIFS, GFS and the blend of six edge ahead of Pluvium, and the differences "
                  "are within the noise except against ENS and HRES."][d]) + "</div>")
    radios = "".join(f'<input class="sc-radio" type="radio" name="sc-day" id="sc-d{d}"{" checked" if d == 1 else ""}>'
                     for d in (1, 2, 3))
    tabs = "".join(f'<label for="sc-d{d}">Day {d}</label>' for d in (1, 2, 3))
    return f"""<div class="sc-days mt-m">
        {radios}
        <div class="sc-tabs" aria-hidden="true">{tabs}</div>
        {"".join(panels)}
      </div>"""


def table():
    FEAT = ' class="is-featured"'
    head = "".join(
        f'<th scope="col"{FEAT if SYSTEMS[k][3] == "featured" else ""}>{icon(k)}'
        f'{html.escape(SYSTEMS[k][0])}<small>{html.escape(SYSTEMS[k][1])}</small></th>' for k in ORDER)
    n = len(ORDER) + 1

    def row(label, sub, data, fmt, lower_better=False, sig=None):
        vals = {k: data.get(k) for k in ORDER}
        cand = {k: v for k, v in vals.items() if v is not None and SYSTEMS[k][3] != "ref"}
        pick = min if lower_better else max
        best = {k for k, v in cand.items() if v == pick(cand.values())}
        singles = {k: v for k, v in cand.items() if SYSTEMS[k][3] in ("featured", "other")}
        single = {k for k, v in singles.items() if v == pick(singles.values())} - best
        if any(SYSTEMS[k][3] in ("featured", "other") for k in best):
            single = set()
        cells = []
        for k in ORDER:
            v = vals[k]
            cls = []
            if SYSTEMS[k][3] == "featured": cls.append("is-featured")
            if SYSTEMS[k][3] == "ref": cls.append("is-ref")
            if v is None:
                cells.append(f'<td class="{" ".join(cls + ["is-na"])}">&mdash;</td>'); continue
            if k in best: cls.append("is-best")
            elif k in single: cls.append("is-best-single")
            mark = '<span class="sc-sig" title="Pluvium better with 95% confidence">&bull;</span>' if sig and k in sig else ""
            attr = ' class="' + " ".join(cls) + '"' if cls else ""
            cells.append(f'<td{attr}>{fmt(v)}{mark}</td>')
        return f'<tr><th scope="row">{label}<small>{sub}</small></th>{"".join(cells)}</tr>'

    def group(text, hint):
        return f'<tr class="sc-group"><th colspan="{n}" scope="colgroup">{text}<em>{hint}</em></th></tr>'

    mm = lambda v: f"{v:.2f}"
    rows = [group("Rain at all &mdash; at least 1&nbsp;mm", "Brier skill, higher is better")]
    rows += [row(f"Day {d + 1}", "July&ndash;August 2025", {k: v[d] for k, v in BSS1.items()}, pct, sig=SIG1[d]) for d in range(3)]
    rows += [group("Wetter days &mdash; at least 10&nbsp;mm", "Brier skill, higher is better")]
    rows += [row(f"Day {d + 1}", "July&ndash;August 2025", {k: v[d] for k, v in BSS10.items()}, pct, sig=SIG10[d]) for d in range(3)]
    rows += [group("Telling rainy days from dry ones &mdash; day 1", "ROC area, higher is better; 50% is chance")]
    rows += [row("At least 1&nbsp;mm", "July&ndash;August 2025", ROC1, pct),
             row("At least 10&nbsp;mm", "July&ndash;August 2025", ROC10, pct)]
    rows += [group("How much falls &mdash; daily totals", "CRPS in mm, lower is better; raw forecasts")]
    rows += [row(f"Day {d + 1}", "July&ndash;August 2025", {k: v[d] for k, v in CRPS.items()}, mm, lower_better=True) for d in range(3)]
    rows += [group("The test Pluvium lost &mdash; at least 1&nbsp;mm", "Brier skill, higher is better")]
    rows += [row(f"Day {d + 1}", "May&ndash;June 2025", {k: v[d] for k, v in MAYJUN1.items()}, pct) for d in range(3)]
    return f"""<div class="table-wrap mt-m" data-reveal>
        <table class="sc-table">
          <caption class="visually-hidden">Pluvium against six operational forecast systems and two blends on Jamaica: Brier skill scores and ROC areas as percentages (higher is better) and CRPS in millimetres (lower is better), with the best value in each row marked</caption>
          <thead><tr><th scope="col"><span class="visually-hidden">Score</span></th>{head}</tr></thead>
          <tbody>
            {"".join(rows)}
          </tbody>
        </table>
      </div>
      <p class="sc-note">&#9733; Best in the row, among every system and blend (the never-rain reference is
        not counted). A dashed outline marks the best single forecast system when a blend is ahead of it. <span class="sc-sig">&bull;</span> Pluvium better than this system with 95% confidence
        (moving-block bootstrap over days). Brier skill scores and ROC areas are shown as percentages.
        CRPS compares raw forecasts, and only Pluvium was trained on the CMORPH truth, so part of its
        lead there is calibration. The blends have no single amount forecast, so no CRPS. Source:
        Pluvium&rsquo;s operational benchmark; tested model pluvium-small (0.9M parameters), driven by GFS.</p>"""


def scorecard():
    """The block that opens the Results section."""
    roc = bar_chart(ROC1, title="Telling rainy days from dry ones &mdash; day 1, at least 1&nbsp;mm",
                    sub="ROC area after calibration, as a percentage. 50% is a coin toss, 100% is perfect; "
                        "bars start at 50%. Jamaica, July&ndash;August 2025.",
                    floor=.5, note="A system with no skill would sit on the baseline. Pluvium ranks rainy and dry "
                                   "days better than any single operational system.")
    return f"""<h3 class="mt-m" id="scorecard">Jamaica, July&ndash;August 2025: Pluvium&rsquo;s own network against the six</h3>
      <div class="prose">
        <p>The first test of Pluvium&rsquo;s hour-by-hour network itself, at its small size (0.9M parameters,
          about two hours of training on a CPU) and driven only by GFS, against the six operational systems and
          two blends of them, on 450 land cells covering Jamaica. Skill scores are percentages, so a taller bar
          is a better forecast. Choose a day:</p>
      </div>
      {day_tabs()}
      {KEY}
      <div class="mt-m">{roc}</div>
      {table()}"""


def mayjun_chart():
    return bar_chart({k: v[0] for k, v in MAYJUN1.items()},
                     title="The test Pluvium lost &mdash; at least 1&nbsp;mm, day 1, May&ndash;June 2025",
                     sub="Brier skill score as a percentage, isotonic calibration (the protocol fixed for this test).",
                     note="After a wet April it had never trained on, calibration turned Pluvium&rsquo;s forecasts "
                          "into false alarms, and it fell below climatology.")


# ----------------------------------------------------------------------------------------------
# Full year, April 2025 - March 2026 (docs/FULL_YEAR_BENCHMARK.md, "Headline: rain of 1 mm or more"):
# Brier skill of Pluvium Blend, and of the best of every other system, raw or post-processed.
LEADS = ["Days 1&ndash;3", "Days 4&ndash;7", "Days 8&ndash;10", "Days 11&ndash;14"]
PLACES = [  # name, region note, [(blend, best other, which) per lead group]
    ("Jamaica", "8 km, with Pluvium&rsquo;s network",
     [(.192, .179, "gc"), (.138, .118, "aifs"), (.074, .085, "gc"), (-.004, -.004, "aifs")]),
    ("Caribbean", "islands and coasts",
     [(.228, .218, "aifs"), (.167, .156, "aifs"), (.102, .089, "aifs"), (.052, .043, "ens")]),
    ("Maritime Continent", "deep tropical convection",
     [(.304, .294, "aifs"), (.244, .226, "aifs"), (.169, .155, "aifs"), (.114, .109, "aifs")]),
    ("Alps", "mid-latitude mountains",
     [(.504, .493, "ens"), (.340, .315, "ens"), (.139, .117, "ens"), (.032, .027, "ens")]),
    ("US Pacific Northwest", "coast and mountains",
     [(.380, .366, "ens"), (.254, .235, "ens"), (.096, .078, "ens"), (.003, .002, "aifs")]),
    ("US Great Plains", "mid-latitude storms",
     [(.476, .463, "aifs"), (.310, .290, "aifs"), (.140, .121, "ens"), (.032, .028, "ens")]),
    ("Southern Andes", "and Chile",
     [(.426, .417, "ens"), (.291, .280, "ens"), (.144, .132, "ens"), (.047, .051, "ens")]),
]
SCOREBOARD = [  # score, places (of 7) where Pluvium Blend beat every other system, by lead group
    ("Brier skill, 1&nbsp;mm", (7, 7, 6, 6)), ("Brier skill, 10&nbsp;mm", (7, 7, 7, 3)),
    ("Brier skill, 25&nbsp;mm", (6, 6, 7, 4)), ("Brier skill, 50&nbsp;mm", (3, 3, 3, 5)),
    ("Critical success index, 1&nbsp;mm", (7, 6, 6, 2)), ("Critical success index, 10&nbsp;mm", (6, 6, 7, 3)),
    ("ROC area, 1&nbsp;mm", (7, 7, 6, 4)), ("CRPS", (6, 7, 7, 3)), ("RMSE", (4, 6, 6, 4)),
    ("Anomaly correlation", (6, 5, 3, 2)),
]


def place_chart(lead):
    rows = [(name, note, *vals[lead]) for name, note, vals in PLACES]
    allv = [v for r in rows for v in r[2:4]]
    lo, hi = min(min(allv), 0), max(allv)
    ticks = nice_ticks(lo, hi); lo, hi = ticks[0], ticks[-1]
    pos = lambda v: (v - lo) / (hi - lo) * 100
    axis = "".join(f'<span style="bottom:{pos(t):.2f}%">{axis_pct(t)}</span>' for t in ticks)
    grid = "".join(f'<div class="sc-grid{" is-zero" if abs(t) < 1e-9 else ""}" style="bottom:{pos(t):.2f}%"></div>'
                   for t in ticks)

    def col(v, cls):
        up = v >= 0
        b = pos(0) if up else pos(v)
        h = abs(pos(v) - pos(0))
        return (f'<div class="sc-col {"is-up" if up else "is-down"} {cls}" style="--b:{b:.2f}%;--h:{h:.2f}%">'
                f'<div class="sc-bar"></div><span class="sc-val">{pct(v)}</span></div>')
    cols, names, aria = [], [], []
    for name, note, blend, other, who in rows:
        cols.append(f'<div class="sc-pair">{col(blend, "is-featured")}{col(other, "")}</div>')
        d = (blend - other) * 100
        verdict = ('<span class="sc-diff is-ahead">+{:.1f} pts</span>'.format(d) if d > 0.05 else
                   '<span class="sc-diff is-behind">−{:.1f} pts</span>'.format(-d) if d < -0.05 else
                   '<span class="sc-diff">level</span>')
        names.append(f'<div class="sc-name"><span class="sc-duo">{icon("pblend", True)}{icon(who, True)}</span>'
                     f'<b>{name}</b><small>vs {SYSTEMS[who][0]} &middot; {note}</small>{verdict}</div>')
        aria.append(f"{name}: Pluvium Blend {pct(blend)}, best other system {SYSTEMS[who][0]} {pct(other)}")
    title = f"Rain of at least 1&nbsp;mm, {LEADS[lead].lower()}, a full year in seven places"
    return f"""<div class="sc-card" data-reveal>
          <div class="sc-head">
            <div><p class="sc-title">{title}</p><p class="sc-sub">Brier skill of Pluvium Blend (dark) beside the best
              of every other system, raw or post-processed (light), April 2025 to March 2026.</p></div>
            <span class="sc-dir"><span aria-hidden="true">&uarr;</span> Higher is better</span>
          </div>
          <div class="sc-scroll">
            <div class="sc-chart" role="img" aria-label="{html.escape(title.replace("&nbsp;", " ").replace("&ndash;", "-"))}. {html.escape("; ".join(aria))}.">
              <div class="sc-axis" aria-hidden="true">{axis}</div>
              <div class="sc-plot" aria-hidden="true">{grid}<div class="sc-bars" style="--n:7">{"".join(cols)}</div></div>
              <div class="sc-names" style="--n:7" aria-hidden="true">{"".join(names)}</div>
            </div>
          </div>
        </div>"""


def full_year():
    radios = "".join(f'<input class="sc-radio" type="radio" name="sc-lead" id="sc-l{i}"{" checked" if i == 1 else ""}>'
                     for i in range(1, 5))
    tabs = "".join(f'<label for="sc-l{i}">{LEADS[i - 1]}</label>' for i in range(1, 5))
    panels = "".join(f'<div class="sc-panel sc-q{i + 1}">{place_chart(i)}</div>' for i in range(4))
    head = "".join(f'<th scope="col">{l}</th>' for l in LEADS)
    body = ""
    for score, counts in SCOREBOARD:
        cells = "".join(f'<td class="{"is-full" if c == 7 else "is-low" if c <= 3 else ""}">'
                        f'<span class="sc-meter" style="--f:{c / 7 * 100:.1f}%"></span>{c} of 7</td>' for c in counts)
        body += f'<tr><th scope="row">{score}</th>{cells}</tr>'
    return f"""<div class="sc-leads mt-m">
        {radios}
        <div class="sc-tabs sc-tabs-lead" aria-hidden="true">{tabs}</div>
        {panels}
      </div>
      <div class="sc-key" aria-hidden="true">
        <span><i class="is-featured"></i> Pluvium Blend</span>
        <span><i></i> Best of every other system, raw or post-processed</span>
      </div>
      <div class="table-wrap mt-m" data-reveal>
        <table class="sc-table sc-board">
          <caption class="visually-hidden">In how many of the seven places Pluvium Blend beat every other system, raw and post-processed, on each score and lead group, April 2025 to March 2026</caption>
          <thead><tr><th scope="col">In how many places it beat every other system</th>{head}</tr></thead>
          <tbody>{body}</tbody>
        </table>
      </div>"""


MELISSA2 = {"aifs": 1.00, "gfs": .98, "gc": .97, "hres": .94, "ens": .90, "gefs": .83, "pblend": .66, "pnet": .20}


def melissa_chart():
    return bar_chart(MELISSA2,
                     title="Hurricane Melissa: the chance of 50&nbsp;mm over Jamaica, two days ahead",
                     sub="Averaged over Jamaica&rsquo;s 450 cells, for 28 October 2025. It came true everywhere: every "
                         "cell had 50&nbsp;mm or more, 154&nbsp;mm on average. Raw forecasts beside Pluvium Blend and "
                         "Pluvium&rsquo;s network.",
                     label=lambda v: f"{v * 100:.0f}%",
                     note="Here a taller bar was the better forecast, and Pluvium came last. Calibration trained on a "
                          "year without such a storm pulled a record forecast back towards normal. The daily table "
                          "now reports how many raw systems call for 50&nbsp;mm, so a storm they agree on is no "
                          "longer hidden.")


# Pluvium Cyclone, East Pacific 2025 (the test season), early guidance, mean track error in nautical miles
# (docs/CYCLONE_BENCHMARK.md). Lower is better.
CYC_LEADS = ["12 h", "24 h", "36 h", "48 h", "60 h", "72 h", "96 h", "120 h"]
CYC = [
    ("Pluvium Cyclone", "CorX Labs, six public systems", (20, 30, 37, 46, 57, 69, 90, 125), True),
    ("NHC official forecast", "National Hurricane Center", (18, 27, 34, 40, 46, 52, 73, 100), False),
    ("NHC consensus TVCN", "National Hurricane Center", (19, 27, 35, 43, 53, 64, 92, 127), False),
    ("NHC corrected consensus HCCA", "National Hurricane Center", (19, 30, 34, 43, 51, 58, 78, 107), False),
]
CYC_N = (130, 110, 92, 76, 64, 53, 39, 30)


def cyclone_table():
    head = "".join(f'<th scope="col">{l}</th>' for l in CYC_LEADS)
    best = [min(r[2][i] for r in CYC) for i in range(8)]
    body = ""
    for name, who, vals, ours in CYC:
        cells = "".join(f'<td class="{" ".join(c for c in ["is-featured" if ours else "", "is-best" if v == best[i] else ""] if c)}">{v}</td>'
                        for i, v in enumerate(vals))
        mark = icon("pluvium", True) if ours else ""
        body += (f'<tr><th scope="row"><span class="sc-rowname">{mark}{name}</span>'
                 f'<small>{who}</small></th>{cells}</tr>')
    body += '<tr><th scope="row">Forecasts compared</th>' + "".join(f'<td class="is-na">{n}</td>' for n in CYC_N) + "</tr>"
    return f"""<div class="table-wrap mt-s" data-reveal>
        <table class="sc-table sc-cyc">
          <caption class="visually-hidden">Mean track error in nautical miles by lead for Pluvium Cyclone and the National Hurricane Center&rsquo;s forecasts, East Pacific 2025 test season, early guidance; lower is better</caption>
          <thead><tr><th scope="col">Track error, nautical miles &mdash; lower is better</th>{head}</tr></thead>
          <tbody>{body}</tbody>
        </table>
      </div>"""
