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
    <p>Where a figure has not been published, the cell reads
      <span class="bm-nil">Not reported</span> rather than an estimate. Nothing here is
      inferred, interpolated or guessed. Each model records the month its row was last
      checked. <a href="/benchmarks/#method">Full method and caveats</a>.</p>
  </div>
</div>""" % ICON_INFO


def bench_cell(key, value, best=False, note=None):
    """A score with its bar. `best` marks the leader in a compared row."""
    if value is None:
        return '<span class="bm-nil">Not reported</span>'
    pct = score_pct(key, value) * 100
    return (
        '<span class="bm-bar%s"><span class="val">%s%s</span>'
        '<span class="track"><span class="fill" style="width:%.1f%%"></span></span>%s</span>'
        % (" is-best" if best else "", fmt_score(key, value),
           '<span class="bm-best-tag">Best</span>' if best else "",
           pct, ('<span class="note">%s</span>' % esc(note)) if note else "")
    )
