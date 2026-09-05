#!/usr/bin/env python3
"""
Shared chrome and formatting for the /benchmarks/ generator.

Split out from build-benchmarks.py so the page builders read as page builders
rather than as string concatenation with a masthead buried in the middle.
"""

import html
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

from model_catalog import BENCH_BY_KEY, BENCHMARKS, BY_SLUG, COMPANIES  # noqa: E402
from logos import logo_url  # noqa: E402

ROOT = os.path.dirname(HERE)
SITE = "https://corx-labs.com"

NAV = [
    ("/chat/", "Chat"),
    ("/documentation/", "Documentation"),
    ("/models/", "Our Products"),
    ("/benchmarks/", "Benchmarks"),
    ("/blog/", "Blog"),
    ("/developers/", "Developers"),
    ("/about/", "About Us"),
    ("/contact/", "Contact"),
]

E = html.escape


def esc(value):
    return html.escape(str(value), quote=True)


# ---------------------------------------------------------------------------
# Formatting
# ---------------------------------------------------------------------------
def fmt_tokens(n):
    """1048576 -> '1M'. Readable beats exact in a table; the title carries exact."""
    if not n:
        return None
    if n >= 1_000_000:
        v = n / 1_000_000
        return ("%gM" % round(v, 1)) if v < 10 else ("%dM" % round(v))
    if n >= 1000:
        v = n / 1000
        return ("%gK" % round(v, 1)) if v < 10 else ("%dK" % round(v))
    return str(n)


def fmt_price(p):
    if p is None:
        return None
    if p == 0:
        return "$0"
    if p < 0.01:
        return "$%.4f" % p
    if p < 1:
        return "$%.3f" % p if (p * 100) % 1 else "$%.2f" % p
    return "$%.2f" % p


def fmt_score(key, value):
    if value is None:
        return None
    return ("%g" % value) if BENCH_BY_KEY[key]["unit"] == "elo" else ("%g%%" % value)


def score_pct(key, value):
    """A 0-1 fraction for the bar. Elo is rescaled across its plausible range."""
    if value is None:
        return 0.0
    if BENCH_BY_KEY[key]["unit"] == "elo":
        return max(0.0, min(1.0, (value - 1000) / 500.0))
    return max(0.0, min(1.0, value / 100.0))


def modality_label(m):
    order = ["text", "image", "audio", "video"]
    names = {"text": "Text", "image": "Image", "audio": "Audio", "video": "Video"}
    got = [x for x in order if x in (m or [])]
    return ", ".join(names[x] for x in got) if got else None


def company_of(model):
    return COMPANIES[model["company"]]


def display_price(model):
    """Input/output price, plus whether it is a third-party hosting rate."""
    pin, pout = model.get("pin"), model.get("pout")
    if pin is None and pout is None:
        return None, None, False
    return fmt_price(pin), fmt_price(pout), bool(model.get("hosted_price"))


def blended_cost(model, in_tokens=3, out_tokens=1):
    """Cost of a 3:1 in/out million-token mix — a fairer single number than
    input price alone, which flatters models that charge on the output side."""
    pin, pout = model.get("pin"), model.get("pout")
    if pin is None or pout is None:
        return None
    return (pin * in_tokens + pout * out_tokens) / (in_tokens + out_tokens)


def model_url(slug):
    return "/benchmarks/models/%s/" % slug


def company_url(cid):
    return "/benchmarks/companies/%s/" % cid


def test_url(key):
    return "/benchmarks/tests/%s/" % key


def compare_url(a, b):
    return "/benchmarks/compare/%s-vs-%s/" % (a, b)


def logo_img(cid, name, size=24, cls="", lazy=True):
    return ('<img class="logo-mark%s" src="%s" width="%d" height="%d" alt="" '
            'aria-hidden="true"%s decoding="async">'
            % ((" " + cls) if cls else "", logo_url(cid), size, size,
               ' loading="lazy"' if lazy else ""))


def logo_tile(cid, name, size=24, tile="", lazy=True):
    return '<span class="logo-tile%s">%s</span>' % (
        (" " + tile) if tile else "", logo_img(cid, name, size, lazy=lazy))


# ---------------------------------------------------------------------------
# Page chrome
# ---------------------------------------------------------------------------
def masthead(current="/benchmarks/"):
    links = "".join(
        '<a href="%s"%s>%s</a>' % (h, ' aria-current="page"' if h == current else "", t)
        for h, t in NAV)
    mobile = "".join('<li><a href="%s">%s</a></li>' % (h, t) for h, t in NAV)
    return """<header class="masthead">
  <div class="shell masthead-inner">
    <a class="brand" href="/" aria-label="CorX Labs — home">
      <span class="mark" aria-hidden="true">C</span>
      <span class="brand-name">CorX Labs</span>
    </a>
    <nav class="nav" aria-label="Primary">%s</nav>
    <div class="masthead-actions">
      <a class="btn btn-primary btn-sm" href="/chat/">Open the chat</a>
      <button class="nav-toggle" type="button" aria-expanded="false" aria-controls="mobile-nav" aria-label="Open menu">
        <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><path d="M3 6h18M3 12h18M3 18h18"/></svg>
      </button>
    </div>
  </div>
  <div class="mobile-nav" id="mobile-nav" data-open="false">
    <div class="shell">
      <ul>%s</ul>
      <a class="btn btn-primary" href="/chat/">Open the chat</a>
    </div>
  </div>
</header>""" % (links, mobile)


FOOTER = """<footer class="site-footer">
  <div class="shell">
    <div class="footer-grid">
      <div class="footer-brand">
        <a class="brand" href="/" aria-label="CorX Labs — home">
          <span class="mark" aria-hidden="true">C</span>
          <span class="brand-name">CorX Labs</span>
        </a>
        <p>An independent AI research lab and research station in Jamaica, the Caribbean.
          Architecting the future, from the ground up.</p>
      </div>
      <nav class="footer-col" aria-label="Benchmarks">
        <h4>Benchmarks</h4>
        <ul>
          <li><a href="/benchmarks/">All models</a></li>
          <li><a href="/benchmarks/leaderboard/">Leaderboard</a></li>
          <li><a href="/benchmarks/compare/">Compare models</a></li>
          <li><a href="/benchmarks/#companies">By company</a></li>
          <li><a href="/benchmarks/#tests">The tests</a></li>
          <li><a href="/benchmarks/#method">Method &amp; sources</a></li>
        </ul>
      </nav>
      <nav class="footer-col" aria-label="Products">
        <h4>Products</h4>
        <ul>
          <li><a href="/models/">All models</a></li>
          <li><a href="/models/corx3-8/">CorX3.8-27B</a></li>
          <li><a href="/models/corx1-5/">CorX1.5</a></li>
          <li><a href="/models/tristream-svs/">TriStream-SVS</a></li>
          <li><a href="/chat/">Chat</a></li>
        </ul>
      </nav>
      <nav class="footer-col" aria-label="Lab">
        <h4>Lab</h4>
        <ul>
          <li><a href="/documentation/">Documentation</a></li>
          <li><a href="/blog/">Blog</a></li>
          <li><a href="/developers/">Developers</a></li>
          <li><a href="/about/">About us</a></li>
          <li><a href="/contact/">Contact</a></li>
        </ul>
      </nav>
    </div>
    <div class="footer-base">
      <span>&copy; <span data-year>2026</span> CorX Labs. Models released under the Apache 2.0 license.</span>
      <span class="made">Made in Jamaica &middot; <a href="mailto:lkk89002@gmail.com">lkk89002@gmail.com</a></span>
    </div>
  </div>
</footer>"""


def page(title, description, canonical, body, jsonld=None, og_image="og-benchmarks.jpg",
         extra_head="", scripts=(), current="/benchmarks/", robots=None):
    """One complete HTML document, with the same head contract as the rest of
    the site so nothing about SEO is special-cased for this section."""
    ld = ""
    if jsonld:
        ld = '\n<script type="application/ld+json">\n%s\n</script>' % json.dumps(
            jsonld, indent=2, ensure_ascii=False)
    script_tags = "".join('\n<script src="%s" defer></script>' % s for s in scripts)
    robots_tag = robots or "index, follow, max-snippet:-1, max-image-preview:large, max-video-preview:-1"
    return """<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">

<title>%(title)s</title>
<meta name="description" content="%(desc)s">
<link rel="canonical" href="%(canonical)s">

<meta name="robots" content="%(robots)s">
<meta name="theme-color" content="#f4f2ec" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#14100c" media="(prefers-color-scheme: dark)">
<meta name="color-scheme" content="light dark">
<link rel="alternate" hreflang="en" href="%(canonical)s">
<link rel="alternate" hreflang="x-default" href="%(canonical)s">

<meta property="og:type" content="website">
<meta property="og:site_name" content="CorX Labs">
<meta property="og:locale" content="en_US">
<meta property="og:url" content="%(canonical)s">
<meta property="og:title" content="%(title)s">
<meta property="og:description" content="%(desc)s">
<meta property="og:image" content="%(site)s/assets/img/%(og)s">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="%(title)s">
<meta name="twitter:description" content="%(desc)s">
<meta name="twitter:image" content="%(site)s/assets/img/%(og)s">

<link rel="icon" href="/favicon.ico" sizes="32x32">
<link rel="icon" href="/assets/img/icon-192.png" type="image/png" sizes="192x192">
<link rel="apple-touch-icon" href="/assets/img/apple-touch-icon.png">
<link rel="manifest" href="/site.webmanifest">
<link rel="alternate" type="application/rss+xml" title="CorX Labs — model releases" href="/feed.xml">

<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:wght@400..600&family=Inter:wght@400..600&display=swap">
<link rel="stylesheet" href="/assets/css/main.css">
<link rel="stylesheet" href="/assets/css/benchmarks.css">
<style>html{background:#f4f2ec}@media(prefers-color-scheme:dark){html{background:#14100c}}</style>%(extra_head)s%(ld)s
</head>
<body>
<a class="skip-link" href="#main">Skip to content</a>

%(masthead)s

<main id="main">
%(body)s
</main>

%(footer)s

<script src="/assets/js/main.js" defer></script>%(scripts)s
</body>
</html>
""" % {
        "title": esc(title), "desc": esc(description), "canonical": esc(canonical),
        "robots": robots_tag, "site": SITE, "og": og_image, "ld": ld,
        "extra_head": extra_head, "masthead": masthead(current),
        "body": body, "footer": FOOTER, "scripts": script_tags,
    }


def crumbs(trail):
    """trail: [(href|None, label)] — the last item is the current page."""
    items = []
    for href, label in trail:
        if href:
            items.append('<li><a href="%s">%s</a></li>' % (href, esc(label)))
        else:
            items.append('<li><span aria-current="page">%s</span></li>' % esc(label))
    return '<nav class="crumbs" aria-label="Breadcrumb"><ol>%s</ol></nav>' % "".join(items)


def crumb_ld(trail, page_id):
    items = []
    for i, (href, label) in enumerate(trail, start=1):
        entry = {"@type": "ListItem", "position": i, "name": label}
        if href:
            entry["item"] = SITE + href
        items.append(entry)
    return {"@type": "BreadcrumbList", "@id": page_id + "#breadcrumb", "itemListElement": items}


ICON_INFO = ('<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" '
             'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
             '<circle cx="12" cy="12" r="9"/><path d="M12 16v-4M12 8h.01"/></svg>')

ICON_ARROW = ('<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" '
              'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
              '<path d="M5 12h14M13 6l6 6-6 6"/></svg>')

ICON_EXTERNAL = ('<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" '
                 'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
                 '<path d="M7 17 17 7M9 7h8v8"/></svg>')

ICON_SEARCH = ('<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" '
               'stroke-linecap="round" aria-hidden="true">'
               '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.6-3.6"/></svg>')


PROVENANCE = """<div class="bm-provenance" id="method-note">
  %s
  <div>
    <h2>Where these numbers come from</h2>
    <p>Every score on this page is a <strong>published</strong> figure, taken from the model's
      own card, system card, technical report or release post, or from a public leaderboard.
      CorX Labs did not run these evaluations. Most are self-reported by the lab that built
      the model, which means they were produced under that lab's own choice of prompt,
      scaffold and number of attempts — so treat them as a starting point for a shortlist,
      not as a settled ranking.</p>
    <p>A score someone other than the model's maker measured is marked
      <span class="bm-src">Independent</span> and names its measurer. Those are the stronger
      numbers on this page — an outside harness has no reason to flatter anyone — and there are
      not many of them.</p>
    <p>Where a figure has not been published, the cell reads
      <span class="bm-nil">Not reported</span> rather than an estimate. Nothing here is
      inferred, interpolated or guessed. Each model records the month its row was last
      checked. <a href="/benchmarks/#method">Full method and caveats</a>.</p>
  </div>
</div>""" % ICON_INFO


# ---------------------------------------------------------------------------
# Category scorecard
#
# The row-by-row table answers "what does each one score"; this answers "which
# one is better at maths", which is the question people actually arrive with.
#
# Averaging inside a category is safe because every benchmark in a group shares
# a unit — Coding is three percentages, Human preference is one Elo — so no
# value is ever rescaled or mixed with a different scale to produce it.
# ---------------------------------------------------------------------------
CATEGORY_ORDER = ["Reasoning", "Maths", "Coding", "Knowledge", "Multimodal",
                  "Instruction following", "Human preference"]

CATEGORY_BLURB = {
    "Reasoning": "Multi-step logic on problems that cannot be looked up",
    "Maths": "Competition mathematics, graded on the final answer",
    "Coding": "Writing and repairing real code",
    "Knowledge": "Breadth of factual recall under exam conditions",
    "Multimodal": "Reading charts, diagrams and photographs",
    "Instruction following": "Obeying an exact, checkable format",
    "Human preference": "Which answer people pick, blind",
}


def category_rows(models):
    """Per-category comparison across only the tests every model reported.

    A category is scored on the intersection, not the union: comparing one
    model's three coding benchmarks against another's one would flatter
    whichever happened to publish the easier set.
    """
    rows = []
    for group in CATEGORY_ORDER:
        keys = [b["key"] for b in BENCHMARKS if b["group"] == group]
        shared = [k for k in keys
                  if all(m.get("b", {}).get(k) is not None for m in models)]
        if not shared:
            reported = [k for k in keys
                        if any(m.get("b", {}).get(k) is not None for m in models)]
            rows.append({"group": group, "shared": [], "values": [None] * len(models),
                         "best": None, "unit": None, "partial": bool(reported)})
            continue
        unit = BENCH_BY_KEY[shared[0]]["unit"]
        values = [sum(m["b"][k] for k in shared) / len(shared) for m in models]
        spread = max(values) - min(values)
        best = max(values) if len(models) > 1 and spread > 0.05 else None
        rows.append({"group": group, "shared": shared, "values": values,
                     "best": best, "unit": unit, "partial": False,
                     "spread": spread})
    return rows


def fmt_category(unit, value):
    if value is None:
        return None
    return ("%g" % round(value)) if unit == "elo" else ("%.1f%%" % value)


def no_scores_notice(models):
    """Seven rows of 'Not comparable' tells a reader nothing. When a model has
    published no scores at all, say so, name it, and say what would change."""
    silent = [m for m in models if not m.get("b")]
    if not silent:
        return ""
    names = " and ".join(esc(m["name"]) for m in silent)
    plural = len(silent) > 1
    return """<div class="bm-provenance" style="margin-bottom:22px">
  %s
  <div>
    <h3>%s %s no published benchmark scores</h3>
    <p>%s maker has not released figures for any of the evaluations tracked here, so there is
      nothing to put in a score column. Rather than estimate, infer from a sibling model, or quote
      the base model's numbers as if they were %s own, this page leaves those rows empty and
      compares what genuinely can be compared: parameters, context window, modalities, licence and
      cost.</p>
    <p>The moment those figures are published they go in — <a href="/contact/">send them with a
      link to the source</a>.</p>
  </div>
</div>""" % (ICON_INFO, names, "have" if plural else "has",
             "Their" if plural else "Its",
             "their" if plural else "its")


def scorecard(models):
    """The clean at-a-glance table: who is better at what."""
    rows = category_rows(models)
    scored = [r for r in rows if r["best"] is not None]
    wins = [0] * len(models)
    for r in scored:
        wins[r["values"].index(r["best"])] += 1

    heads = ['<th scope="col">Category</th>']
    for m in models:
        heads.append('<th scope="col" class="bm-sc-model"><span>%s<span class="n">%s</span></span></th>'
                     % (logo_img(m["company"], "", 18), esc(m["name"])))
    heads.append('<th scope="col">Better at this</th>')

    body = []
    for r in rows:
        label = ('<th scope="row"><span class="g">%s</span><span class="t">%s</span></th>'
                 % (esc(r["group"]),
                    esc(", ".join(BENCH_BY_KEY[k]["name"] for k in r["shared"]))
                    if r["shared"] else
                    ("Only one model reports this" if r["partial"] else "Neither model reports this")))
        if not r["shared"]:
            body.append("<tr>%s%s<td class=\"bm-sc-none\">Not comparable</td></tr>"
                        % (label, '<td class="bm-sc-none">&mdash;</td>' * len(models)))
            continue
        cells = ""
        for v in r["values"]:
            win = r["best"] is not None and v == r["best"]
            cells += ('<td class="bm-sc-val%s">%s%s</td>'
                      % (" is-win" if win else "", esc(fmt_category(r["unit"], v)),
                         '<i class="bm-sc-tick" aria-hidden="true"></i>' if win else ""))
        if r["best"] is None:
            verdict = '<td class="bm-sc-who is-tie">Tied</td>'
        else:
            leader = models[r["values"].index(r["best"])]
            gap = r["spread"]
            verdict = ('<td class="bm-sc-who"><strong>%s</strong>'
                       '<span class="d">+%s</span></td>'
                       % (esc(leader["name"]),
                          ("%g" % round(gap)) if r["unit"] == "elo" else ("%.1f" % gap)))
        body.append("<tr>%s%s%s</tr>" % (label, cells, verdict))

    if scored:
        top = max(wins)
        leaders = [models[i]["name"] for i, w in enumerate(wins) if w == top and top > 0]
        overall = (esc(leaders[0]) if len(leaders) == 1
                   else "Split &mdash; " + esc(" and ".join(leaders)))
        foot = ('<tr><th scope="row"><span class="g">Categories won</span>'
                '<span class="t">Out of %d comparable</span></th>%s'
                '<td class="bm-sc-who"><strong>%s</strong></td></tr>'
                % (len(scored),
                   "".join('<td class="bm-sc-val%s">%d</td>'
                           % (" is-win" if w == top and top > 0 else "", w) for w in wins),
                   overall))
    else:
        foot = ('<tr><th scope="row"><span class="g">Categories won</span></th>'
                '<td class="bm-sc-none" colspan="%d">No category has a test both models report</td></tr>'
                % (len(models) + 1))

    return """%s<div class="bm-sc-wrap">
  <table class="bm-scorecard">
    <caption class="visually-hidden">Which model scores higher in each capability category, averaged over the benchmarks all of them report.</caption>
    <thead><tr>%s</tr></thead>
    <tbody>%s</tbody>
    <tfoot>%s</tfoot>
  </table>
</div>
<p class="bm-sc-note">Each category averages only the benchmarks <strong>every</strong> model here
  reports, so no one is credited for a test the other did not run. A category with no shared test
  is marked <em>Not comparable</em> rather than guessed at.</p>""" % (
        no_scores_notice(models), "".join(heads), "".join(body), foot)


def category_value(model, group):
    """(average, unit, [benchmark keys]) for one model in one category."""
    keys = [b["key"] for b in BENCHMARKS if b["group"] == group]
    have = [k for k in keys if model.get("b", {}).get(k) is not None]
    if not have:
        return None
    return (sum(model["b"][k] for k in have) / len(have),
            BENCH_BY_KEY[have[0]]["unit"], have)


# One benchmark per field decides the ranking, rather than an average of the
# whole group.
#
# Averaging inside a group is fine when two models report the SAME tests — it
# is the same arithmetic on both sides. Across a whole field it is not: a model
# that reported only HumanEval, which is saturated around 92%, would outrank one
# that reported only SWE-bench Verified at 80%, and that is an artefact of which
# test each lab chose, not of capability. So each field ranks on a single test
# every listed model actually sat, and the field header names it.
FIELD_PRIMARY = {
    "Reasoning": "gpqa",
    "Maths": "aime",
    "Coding": "swe",
    "Knowledge": "mmlu_pro",
    "Multimodal": "mmmu",
    "Instruction following": "ifeval",
    "Human preference": "arena",
}


def field_standings(models):
    """For every field, every model reporting its deciding benchmark, best first.

    Returns {group: [(model, value, unit, percentile)]}. Percentile is the share
    of reporting models this one is at least as good as, so a field of 83 and a
    field of 15 can sit in the same overall table without the smaller field
    handing out easy wins.
    """
    out = {}
    for group in CATEGORY_ORDER:
        key = FIELD_PRIMARY[group]
        unit = BENCH_BY_KEY[key]["unit"]
        scored = [(m, m["b"][key]) for m in models
                  if m.get("b", {}).get(key) is not None]
        scored.sort(key=lambda t: -t[1])
        n = len(scored)
        out[group] = [
            (m, v, unit, 100.0 if n == 1 else (n - 1 - i) / (n - 1) * 100.0)
            for i, (m, v) in enumerate(scored)
        ]
    return out


# A model has to report at least this many of the seven fields to be ranked
# overall. Without it, one lucky benchmark outranks a model measured on six.
MIN_FIELDS = 3


def overall_standings(models):
    """Breadth-aware overall ranking. Never a single invented composite score."""
    standings = field_standings(models)
    rank_of = {}
    for group, rows in standings.items():
        for i, (m, v, unit, pct) in enumerate(rows):
            rank_of[(m["slug"], group)] = (i + 1, len(rows), pct, v, unit)

    entries = []
    for m in models:
        fields = [g for g in CATEGORY_ORDER if (m["slug"], g) in rank_of]
        if len(fields) < MIN_FIELDS:
            continue
        pcts = [rank_of[(m["slug"], g)][2] for g in fields]
        tops = sum(1 for g in fields if rank_of[(m["slug"], g)][0] <= 3)
        best = min(fields, key=lambda g: rank_of[(m["slug"], g)][0])
        entries.append({
            "model": m,
            "fields": fields,
            "avg": sum(pcts) / len(pcts),
            "tops": tops,
            "best": best,
            "best_rank": rank_of[(m["slug"], best)][0],
            "best_n": rank_of[(m["slug"], best)][1],
            "ranks": {g: rank_of[(m["slug"], g)] for g in fields},
        })
    entries.sort(key=lambda e: (-e["avg"], -len(e["fields"]), e["model"]["name"]))
    return entries, standings


def category_profile(model, all_models):
    """The same clean shape for a single model: score per category, and where
    that sits among every model reporting the same tests."""
    rows = []
    for group in CATEGORY_ORDER:
        keys = [b["key"] for b in BENCHMARKS if b["group"] == group]
        have = [k for k in keys if model.get("b", {}).get(k) is not None]
        if not have:
            rows.append('<tr><th scope="row"><span class="g">%s</span>'
                        '<span class="t">%s</span></th>'
                        '<td class="bm-sc-none">Not reported</td>'
                        '<td class="bm-sc-none">&mdash;</td></tr>'
                        % (esc(group), esc(CATEGORY_BLURB[group])))
            continue
        unit = BENCH_BY_KEY[have[0]]["unit"]
        value = sum(model["b"][k] for k in have) / len(have)

        peers = []
        for other in all_models:
            got = [k for k in have if other.get("b", {}).get(k) is not None]
            if len(got) == len(have):
                peers.append(sum(other["b"][k] for k in have) / len(have))
        peers.sort(reverse=True)
        rank = peers.index(value) + 1 if value in peers else None
        place = ("%d of %d reporting the same tests" % (rank, len(peers))
                 if rank and len(peers) > 1 else "Only model reporting these")
        rows.append('<tr><th scope="row"><span class="g">%s</span>'
                    '<span class="t">%s</span></th>'
                    '<td class="bm-sc-val%s">%s</td>'
                    '<td class="bm-sc-who">%s</td></tr>'
                    % (esc(group), esc(", ".join(BENCH_BY_KEY[k]["name"] for k in have)),
                       " is-win" if rank == 1 and len(peers) > 1 else "",
                       esc(fmt_category(unit, value)), esc(place)))

    return """<div class="bm-sc-wrap">
  <table class="bm-scorecard">
    <caption class="visually-hidden">%s by capability category, with its rank among models reporting the same tests.</caption>
    <thead><tr><th scope="col">Category</th><th scope="col">Score</th>
      <th scope="col">Rank</th></tr></thead>
    <tbody>%s</tbody>
  </table>
</div>
<p class="bm-sc-note">A category averages every benchmark in it that %s reports. The rank counts
  only models that report the <strong>same</strong> tests, so it never compares an average over
  three benchmarks against an average over one.</p>""" % (
        esc(model["name"]), "".join(rows), esc(model["name"]))


def bench_cell(key, value, best=False, note=None, source=None):
    """A score with its bar. `best` marks the leader in a compared row.

    `source` names an independent measurer. Most scores in this index are the
    model maker's own; one that someone else ran is a stronger fact, not a
    weaker one, so it is labelled rather than silently mixed in.
    """
    if value is None:
        return '<span class="bm-nil">Not reported</span>'
    pct = score_pct(key, value) * 100
    tag = ""
    if source:
        tag = ('<span class="bm-src" title="Measured by %s, not by the model\u2019s maker">'
               'Independent</span>' % esc(source))
    return (
        '<span class="bm-bar%s"><span class="val">%s%s%s</span>'
        '<span class="track"><span class="fill" style="width:%.1f%%"></span></span>%s</span>'
        % (" is-best" if best else "", fmt_score(key, value),
           '<span class="bm-best-tag">Best</span>' if best else "", tag,
           pct, ('<span class="note">%s</span>' % esc(note)) if note else "")
    )
