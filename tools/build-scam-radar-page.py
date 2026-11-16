#!/usr/bin/env python3
"""Generate scam-radar/index.html:  python3 tools/build-scam-radar-page.py

The page is static. Its numbers come from assets/data/scam-radar.json, which the scheduled job
(.github/workflows/scam-radar.yml) rewrites after every scan, and assets/js/scam-radar.js draws them.
The world map is drawn here once, from Natural Earth's 1:110m countries (public domain), with each
country tagged by its two-letter code.
"""
import html
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = (ROOT / "models/naturev1/index.html").read_text(encoding="utf-8")
OUT = ROOT / "scam-radar/index.html"
URL = "https://corx-labs.com/scam-radar/"
OG = "https://corx-labs.com/assets/img/og-scam-radar.jpg"
DATE = "2026-11-16"
PLUS = ('<span class="plus" aria-hidden="true"><svg viewBox="0 0 24 24" width="12" height="12" fill="none" '
        'stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg></span>')


def plain(fragment):
    return re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]+>", "", fragment))).strip()


def block(start, end):
    i = SRC.index(start)
    return SRC[i:SRC.index(end, i) + len(end)]


# ---------------------------------------------------------------- chrome
masthead = block('<header class="masthead">', "</header>")
masthead = masthead.replace('<a href="/models/" aria-current="page">Our Products</a>', '<a href="/models/">Our Products</a>')
hf = 'href="https://huggingface.co/Sigmandndnns/NatureV1-500" rel="noopener" target="_blank"'
masthead = masthead.replace(f'<a class="btn btn-primary btn-sm" {hf}>Hugging Face</a>',
                            '<a class="btn btn-primary btn-sm" href="#map">See the map</a>')
masthead = masthead.replace(f'<a class="btn btn-primary" {hf}>View on Hugging Face</a>',
                            '<a class="btn btn-primary" href="#map">See the map</a>')
assert "huggingface" not in masthead
footer = block('<footer class="site-footer">', "</footer>")

# ---------------------------------------------------------------- world map
topo = json.loads((ROOT / "tools/scam-radar/world-110m.json").read_text())
codes = json.loads((ROOT / "tools/scam-radar/iso3-to-iso2.json").read_text())
arcs = topo["arcs"]
W, TOP, BOTTOM = 1000.0, 84.0, -58.0
H = W * (TOP - BOTTOM) / 360.0


def arc(i):
    pts = arcs[i] if i >= 0 else arcs[~i][::-1]
    return pts


def ring(indices):
    pts = []
    for i in indices:
        a = arc(i)
        pts.extend(a if not pts else a[1:])
    return pts


def path(rings):
    out = []
    for r in rings:
        xy = [((lon + 180) / 360 * W, (TOP - lat) / (TOP - BOTTOM) * H) for lon, lat in r]
        xy = [(round(x, 1), round(y, 1)) for x, y in xy]
        dedup = [p for k, p in enumerate(xy) if k == 0 or p != xy[k - 1]]
        if len(dedup) < 3:
            continue
        out.append("M" + "L".join(f"{x:g},{y:g}" for x, y in dedup) + "Z")
    return "".join(out)


paths = []
for g in topo["objects"]["world"]["geometries"]:
    gid, name = g.get("id", ""), g["properties"]["name"]
    if gid == "ATA":
        continue
    cc = (codes.get(gid) or codes.get(f"{gid}:{name}") or [None])[0]
    if name == "West Bank":
        cc = "PS"
    rings = [ring(r) for r in g["arcs"]] if g["type"] == "Polygon" else [ring(r) for p in g["arcs"] for r in p]
    d = path(rings)
    if d:
        attr = f' data-cc="{cc}"' if cc else ""
        paths.append(f'<path{attr} d="{d}"><title>{html.escape(name)}</title></path>')
MAP = (f'<svg class="sr-map" viewBox="0 0 {W:g} {H:.0f}" role="img" aria-labelledby="sr-map-title" '
       f'preserveAspectRatio="xMidYMid meet"><title id="sr-map-title">World map of live scam sites by '
       f'country</title>{"".join(paths)}</svg>')

# ---------------------------------------------------------------- FAQ
FAQ = [
    ("What is Scam Radar?",
     "Scam Radar is a scanner from CorX Labs that watches the internet for scam and phishing websites as they "
     "appear. It keeps an index of more than 18 million domains, reads newly issued web certificates and newly "
     "registered names, visits the suspicious ones, and records when each goes live, changes or is taken "
     "down. This page shows what it found in its latest scans, by country."),
    ("How often does it update?",
     "A scheduled job runs a round of scans every three hours and publishes the results by itself. This page "
     "checks for a new scan every minute and shows how old the current one is, to the second. Between scans "
     "the scanner is not running, so the numbers don&rsquo;t change; a live feed would need a server that "
     "scans around the clock."),
    ("How does it know my country?",
     "From your device&rsquo;s time zone, worked out in your browser. Nothing about you is sent anywhere, and "
     "you can pick another country from the list; the choice is remembered on this device only."),
    ("Is every site listed here certainly a scam?",
     "No tool can promise that. A site is only named here when the evidence is strong: it is up, it scores 70 "
     "or more out of 100, and it either runs a scam kit the scanner recognises or is already on a public scam "
     "or phishing blocklist. A suspicious spelling alone is counted in the country totals but never named. "
     "If you think a site is listed by mistake, email lkk89002@gmail.com and it will be checked."),
    ("What do the countries mean?",
     "Aimed at is the country a scam targets, worked out from the brand it impersonates, the currency or flag "
     "in its title, or the language it uses. Hosted in is the country of the server, when that can be seen. "
     "Many scam sites hide behind networks such as Cloudflare, and for those the server&rsquo;s country is not "
     "shown rather than guessed."),
    ("I got a scam link. What should I do?",
     "Don&rsquo;t open it and don&rsquo;t enter anything. If it uses your bank&rsquo;s or a company&rsquo;s name, "
     "tell that company through its official number or website. You can report the link to Google Safe "
     "Browsing so browsers warn other people, and to the police if you lost money."),
    ("Who built it?",
     "<a href=\"/nathan/\">Nathan Lyttle</a>, the founder of CorX Labs, as Scam Finder: a tool that starts from "
     "one scam link and maps the operation behind it, and Radar, the part that never stops scanning. It "
     "started from a real WhatsApp &ldquo;gift&rdquo; scam that used a Jamaican brand&rsquo;s name."),
]
faq_html = "\n".join(f"""        <details>
          <summary>{q}{PLUS}</summary>
          <div class="faq-body"><p>{a}</p></div>
        </details>""" for q, a in FAQ)

person = {"@type": "Person", "@id": "https://corx-labs.com/#nathan", "name": "Nathan Lyttle", "url": "https://corx-labs.com/nathan/"}
graph = [
    {"@type": "WebApplication", "@id": URL + "#app", "name": "Scam Radar", "url": URL,
     "applicationCategory": "SecurityApplication", "operatingSystem": "Any (web browser)",
     "description": "A live map of scam and phishing websites by the country they target and the country that "
                    "hosts them, from a scanner that watches more than 18 million domains, newly issued "
                    "certificates and newly registered names, and records when each scam site goes live or is "
                    "taken down. Sites are only named when they run a recognised scam kit or are already on a "
                    "public blocklist.",
     "isAccessibleForFree": True, "image": OG, "author": person,
     "publisher": {"@id": "https://corx-labs.com/#organization"}, "datePublished": DATE, "dateModified": DATE,
     "offers": {"@type": "Offer", "price": "0", "priceCurrency": "USD", "availability": "https://schema.org/InStock"},
     "countryOfOrigin": {"@type": "Country", "name": "Jamaica"}},
    {"@type": "WebPage", "@id": URL + "#webpage", "url": URL, "name": "Scam Radar: live scam websites by country",
     "isPartOf": {"@id": "https://corx-labs.com/#website"}, "mainEntity": {"@id": URL + "#app"},
     "inLanguage": "en", "datePublished": DATE, "dateModified": DATE,
     "breadcrumb": {"@id": URL + "#breadcrumb"}},
    {"@type": "BreadcrumbList", "@id": URL + "#breadcrumb", "itemListElement": [
        {"@type": "ListItem", "position": 1, "name": "Home", "item": "https://corx-labs.com/"},
        {"@type": "ListItem", "position": 2, "name": "Scam Radar", "item": URL}]},
    {"@type": "FAQPage", "@id": URL + "#faq", "isPartOf": {"@id": URL + "#webpage"},
     "mainEntity": [{"@type": "Question", "name": q, "acceptedAnswer": {"@type": "Answer", "text": plain(a)}}
                    for q, a in FAQ]},
]
ld = json.dumps({"@context": "https://schema.org", "@graph": graph}, ensure_ascii=False, indent=2)
assert "</" not in ld

DESC = "Live scam and phishing websites by country, from a scanner watching 18 million domains. See the scams aimed at your country. Updated by itself."
assert len(DESC) <= 160, len(DESC)

page = f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">

<title>Scam Radar — Live Scam Websites by Country | CorX Labs</title>
<meta name="description" content="{DESC}">
<link rel="canonical" href="{URL}">

<meta name="robots" content="index, follow, max-snippet:-1, max-image-preview:large, max-video-preview:-1">
<meta name="author" content="Nathan Lyttle">
<meta name="theme-color" content="#f4f2ec" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#14100c" media="(prefers-color-scheme: dark)">
<meta name="color-scheme" content="light dark">
<link rel="alternate" hreflang="en" href="{URL}">
<link rel="alternate" hreflang="x-default" href="{URL}">

<meta property="og:type" content="website">
<meta property="og:site_name" content="CorX Labs">
<meta property="og:locale" content="en_US">
<meta property="og:url" content="{URL}">
<meta property="og:title" content="Scam Radar — live scam websites by country">
<meta property="og:description" content="Which countries scam websites are aiming at right now, from a scanner that watches 18 million domains and records every takedown. Updated by itself.">
<meta property="og:image" content="{OG}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:image:alt" content="Scam Radar — live scam websites by country">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:site" content="@corxlabs">
<meta name="twitter:title" content="Scam Radar — live scam websites by country">
<meta name="twitter:description" content="Which countries scam websites are aiming at right now, and which ones were taken down. Updated by itself several times a day.">
<meta name="twitter:image" content="{OG}">

<link rel="icon" href="/favicon.ico" sizes="32x32">
<link rel="icon" href="/assets/img/icon-192.png" type="image/png" sizes="192x192">
<link rel="apple-touch-icon" href="/assets/img/apple-touch-icon.png">
<link rel="manifest" href="/site.webmanifest">
<link rel="alternate" type="application/rss+xml" title="CorX Labs — model releases" href="/feed.xml">

<link rel="preload" href="/assets/fonts/inter-latin.3100e775.woff2" as="font" type="font/woff2" crossorigin>
<link rel="preload" href="/assets/fonts/cormorant-garamond-latin.d80df8ff.woff2" as="font" type="font/woff2" crossorigin>
<link rel="stylesheet" href="/assets/css/main.css">
<link rel="stylesheet" href="/assets/css/scam-radar.css">
<style>html{{background:#f4f2ec}}@media(prefers-color-scheme:dark){{html{{background:#14100c}}}}</style>

<script type="application/ld+json">
{ld}
</script>
</head>
<body>
<a class="skip-link" href="#main">Skip to content</a>

{masthead}

<main id="main">

  <div class="shell page-head">
    <nav class="crumbs" aria-label="Breadcrumb">
      <ol>
        <li><a href="/">Home</a></li>
        <li><span aria-current="page">Scam Radar</span></li>
      </ol>
    </nav>
    <div class="tag-row" style="margin-top:22px">
      <span class="tag tag-live"><i class="dot" aria-hidden="true"></i> <span id="sr-age">Live data</span></span>
      <span class="tag">Scam &amp; phishing sites</span>
      <span class="tag">Every country</span>
      <span class="tag">Updates by itself</span>
    </div>
    <h1>Scam Radar</h1>
    <p class="lede">Scam websites going up right now, and the countries they are aiming at. A scanner watches
      more than 18 million domains, every new web certificate and every newly registered name, visits the
      suspicious ones, and records when each goes live and when it is taken down.</p>
    <p class="mt-s sr-status" id="sr-status" aria-live="polite">Loading the latest scan&hellip;</p>
    <noscript><p class="mt-s sr-status">This page needs JavaScript to show the latest numbers. The raw data is at
      <a href="/assets/data/scam-radar.json">/assets/data/scam-radar.json</a>.</p></noscript>
  </div>

  <div class="shell"><hr class="rule"></div>

  <section class="section-tight" id="numbers" aria-label="Headline numbers">
    <div class="shell">
      <dl class="sr-stats" id="sr-stats">
        <div><dt>Domains indexed</dt><dd data-k="domainsIndexed">&ndash;</dd></div>
        <div><dt>Sites watched</dt><dd data-k="watched">&ndash;</dd></div>
        <div><dt>Live, high risk</dt><dd data-k="liveHighRisk">&ndash;</dd></div>
        <div><dt>Taken down</dt><dd data-k="takenDown">&ndash;</dd></div>
      </dl>
    </div>
  </section>

  <section class="section-tight" id="yours" style="padding-top:0">
    <div class="shell">
      <div class="sr-card sr-home">
        <div class="sr-home-head">
          <h2 id="sr-home-title">Scams aimed at your country</h2>
          <label class="sr-pick"><span class="visually-hidden">Country</span>
            <select id="sr-country"><option value="">Choose a country</option></select></label>
        </div>
        <div id="sr-home-body"><p class="sr-note">Loading&hellip;</p></div>
        <p class="sr-note">Your country is guessed from your device&rsquo;s time zone, in your browser. Nothing is sent anywhere.</p>
      </div>
    </div>
  </section>

  <section class="section-tight" id="map" style="padding-top:0">
    <div class="shell">
      <h2>Where the scams are aimed</h2>
      <div class="sr-card mt-m">
        <div class="sr-toggle" role="radiogroup" aria-label="Which country to map">
          <input class="sr-radio" type="radio" name="sr-view" id="sr-view-targets" value="targets" checked>
          <label for="sr-view-targets">Aimed at</label>
          <input class="sr-radio" type="radio" name="sr-view" id="sr-view-hosts" value="hosts">
          <label for="sr-view-hosts">Hosted in</label>
        </div>
        <div class="sr-map-wrap">{MAP}</div>
        <div class="sr-legend" aria-hidden="true"><span>Fewer</span><i></i><i></i><i></i><i></i><i></i><span>More live scam sites</span></div>
        <p class="sr-note" id="sr-map-note">Countries are shaded by how many live, high-risk scam sites are aimed at them.</p>
      </div>
      <div class="table-wrap mt-m">
        <table class="sr-table" id="sr-countries">
          <caption class="visually-hidden">Live high-risk scam sites by country</caption>
          <thead><tr><th scope="col">Country</th><th scope="col">Live scam sites</th><th scope="col" aria-label="Share of the busiest country"></th></tr></thead>
          <tbody><tr><td colspan="3">Loading&hellip;</td></tr></tbody>
        </table>
      </div>
    </div>
  </section>

  <section class="section-tight" id="leaderboard">
    <div class="shell">
      <h2>Leaderboard</h2>
      <div class="prose"><p>Counted over every live, high-risk scam site in the latest scan.</p></div>
      <div class="sr-board mt-m">
        <input class="sr-radio" type="radio" name="sr-lb" id="sr-lb-1" checked>
        <input class="sr-radio" type="radio" name="sr-lb" id="sr-lb-2">
        <input class="sr-radio" type="radio" name="sr-lb" id="sr-lb-3">
        <input class="sr-radio" type="radio" name="sr-lb" id="sr-lb-4">
        <div class="sr-toggle sr-lb-tabs" aria-hidden="true">
          <label for="sr-lb-1">Most targeted countries</label>
          <label for="sr-lb-2">Most faked brands</label>
          <label for="sr-lb-3">Most copied scam kits</label>
          <label for="sr-lb-4">Hosting networks</label>
        </div>
        <div class="sr-card sr-lb sr-lb-p1"><h3 class="visually-hidden">Most targeted countries</h3><ol class="sr-rankings" id="sr-lb-countries"><li>Loading&hellip;</li></ol></div>
        <div class="sr-card sr-lb sr-lb-p2"><h3 class="visually-hidden">Most faked brands</h3><ol class="sr-rankings" id="sr-lb-brands"><li>Loading&hellip;</li></ol></div>
        <div class="sr-card sr-lb sr-lb-p3"><h3 class="visually-hidden">Most copied scam kits</h3><ol class="sr-rankings" id="sr-lb-kits"><li>Loading&hellip;</li></ol></div>
        <div class="sr-card sr-lb sr-lb-p4"><h3 class="visually-hidden">Hosting networks with the most live scam sites</h3>
          <ol class="sr-rankings" id="sr-lb-networks"><li>Loading&hellip;</li></ol>
          <p class="sr-note">A network that hosts a scam site has usually not chosen to. Reporting the site to the
            network&rsquo;s abuse team is often the fastest way to get it taken down.</p></div>
      </div>
    </div>
  </section>

  <section class="section-tight" id="named">
    <div class="shell">
      <h2>Live scam sites with strong evidence</h2>
      <div class="prose">
        <p>Only sites that run a scam kit the scanner recognises, or that are already on a public scam or
          phishing blocklist, are named. Names are written so they can&rsquo;t be clicked: <code>example[.]com</code>.
          Don&rsquo;t visit them.</p>
      </div>
      <div class="table-wrap mt-m">
        <table class="sr-table" id="sr-named">
          <caption class="visually-hidden">Live scam sites named with their evidence</caption>
          <thead><tr><th scope="col">Site</th><th scope="col">Aimed at</th><th scope="col">Evidence</th><th scope="col">Pretends to be</th><th scope="col">First seen</th></tr></thead>
          <tbody><tr><td colspan="5">Loading&hellip;</td></tr></tbody>
        </table>
      </div>
    </div>
  </section>

  <section class="section-tight" id="takedowns">
    <div class="shell">
      <h2>Taken down this week</h2>
      <ul class="sr-downs mt-s" id="sr-downs"><li>Loading&hellip;</li></ul>
    </div>
  </section>

  <section class="section-tight" id="how">
    <div class="shell">
      <h2>How it works</h2>
      <ol class="steps mt-m">
        <li><div><h3>Every name, scored by its spelling</h3><p>18 million domains from the Common Crawl web graph,
          the Tranco top million, public blocklists, names registered in the last 30 days and new web
          certificates. Each is scored in a microsecond from borrowed brand names, bait words, cheap endings
          and machine-made labels. Batches registered by script give themselves away by sharing a mould.</p></div></li>
        <li><div><h3>The suspicious ones, visited</h3><p>The highest-scoring names go on a watchlist. A dead site is
          settled by one DNS answer; a live one is fetched as plain text, never run, and its code is checked for 23
          scam behaviours, from passwords sent to a Telegram bot to wallet-draining approvals.</p></div></li>
        <li><div><h3>Watched until they go</h3><p>Live high-risk sites are revisited every half hour to two hours.
          When one stops answering twice in a row, the takedown is recorded with when and why: gone from DNS,
          suspended by the registrar, or flagged by its host.</p></div></li>
        <li><div><h3>Published by itself</h3><p>A scheduled job runs a round of scans every three hours and
          publishes the results when it finishes. This page checks for them every minute. Nobody edits the list
          by hand.</p></div></li>
      </ol>
      <div class="callout mt-m">
        <p><strong>What it can&rsquo;t tell you.</strong> How many people clicked: only the scammers know. Who is
          behind a site: it maps servers and registrations, not people. And it can be wrong, which is why a site is
          only named on strong evidence. If you think a site is listed by mistake, email
          <a href="mailto:lkk89002@gmail.com">lkk89002@gmail.com</a>.</p>
      </div>
    </div>
  </section>

  <section class="section-tight" id="faq">
    <div class="shell">
      <h2>Questions</h2>
      <div class="faq mt-m">
{faq_html}
      </div>
      <p class="sr-note mt-m">Built on Scam Finder by CorX Labs, inside <a href="https://github.com/lissy93/web-check" rel="noopener nofollow" target="_blank">Web-Check</a>
        (MIT licence, Alicia Sykes). Data: Common Crawl, Tranco, public scam and phishing blocklists, Certificate
        Transparency logs and newly registered domain lists. Map: Natural Earth.</p>
    </div>
  </section>
</main>

{footer}

<script src="/assets/js/scam-radar.js" defer></script>
<script src="/assets/js/main.js" defer></script>
</body>
</html>
"""
OUT.parent.mkdir(parents=True, exist_ok=True)
OUT.write_text(page, encoding="utf-8")
print("wrote", OUT, f"{len(page) // 1024} KB,", len(paths), "countries on the map")
