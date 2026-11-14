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


def icon_src(key):
    org = OFFICIAL_FOR.get(key)
    for ext in ("svg", "png", "webp"):
        if org and (OFFICIAL_DIR / f"{org}.{ext}").is_file():
            return f"/assets/img/logos/weather/official/{org}.{ext}"
    return f"/assets/img/logos/weather/{SYSTEMS[key][2]}.svg"


def icon(key, small=False):
    return ICON.format(cls=" is-sm" if small else "", src=icon_src(key), w=20 if small else 26)


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
    return f"""<h3 class="mt-m" id="scorecard">Scorecard</h3>
      <div class="prose">
        <p>Pluvium against the six operational systems and two blends of them, on 450 land cells covering
          Jamaica. Skill scores are shown as percentages, so a taller bar is a better forecast.
          Choose a day:</p>
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
