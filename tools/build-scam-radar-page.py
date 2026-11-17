#!/usr/bin/env python3
"""Generate scam-radar/index.html:  python3 tools/build-scam-radar-page.py

The page ships with real numbers already in it: this script fills them in from
assets/data/scam-radar.json, a copy of the scanner's latest snapshot. assets/js/scam-radar.js then
redraws everything from the newest snapshot on the scam-radar-data branch, which the scan workflow
(.github/workflows/scam-radar.yml) republishes after every one-minute scan cycle, around the clock.

Refresh the copy before building, so the built page starts close to the truth:
    curl -s https://raw.githubusercontent.com/Wisk-inc/Jrjdjd/scam-radar-data/scam-radar.json -o assets/data/scam-radar.json

Site names and page titles are never written into the HTML here. They are drawn in the browser.
The world map is drawn here once, from Natural Earth's 1:110m countries (public domain), with each
country tagged by its two-letter code.
"""
import html
import json
import re
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = (ROOT / "models/naturev1/index.html").read_text(encoding="utf-8")
OUT = ROOT / "scam-radar/index.html"
URL = "https://www.corx-labs.com/scam-radar/"
OG = "https://www.corx-labs.com/assets/img/og-scam-radar.jpg"
PUBLISHED = "2026-11-16"
DATE = "2026-11-16"
PLUS = ('<span class="plus" aria-hidden="true"><svg viewBox="0 0 24 24" width="12" height="12" fill="none" '
        'stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg></span>')

SNAP = json.loads((ROOT / "assets/data/scam-radar.json").read_text(encoding="utf-8"))
assert SNAP.get("generated"), "assets/data/scam-radar.json has no scan in it: refresh it first (see the top of this file)"
NAMES = json.loads((ROOT / "tools/scam-radar/country-names.json").read_text(encoding="utf-8"))
THE = {"AE", "BS", "CF", "CK", "DO", "FK", "FO", "GB", "GM", "KM", "KY", "MH", "MP", "MV", "NL", "PH", "SB", "TC", "UM",
       "US", "VG", "VI"}


def esc(text):
    return html.escape(str(text), quote=True)


def num(n):
    return f"{int(n or 0):,}"


def flag(cc):
    return "".join(chr(0x1F1A5 + ord(c)) for c in cc) if re.fullmatch(r"[A-Z]{2}", cc or "") else ""


def country(cc):
    return f"{flag(cc)} {NAMES.get(cc, cc)}".strip()


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
                            '<a class="btn btn-primary btn-sm" href="#check">Check a link</a>')
masthead = masthead.replace(f'<a class="btn btn-primary" {hf}>View on Hugging Face</a>',
                            '<a class="btn btn-primary" href="#check">Check a link</a>')
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

# ---------------------------------------------------------------- the snapshot, written into the page
T = SNAP["totals"]
when = datetime.fromisoformat(SNAP["generated"].replace("Z", "+00:00")).astimezone(timezone.utc)
WHEN = f"{when.day} {when:%B %Y} at {when:%H:%M} UTC"

# The live console. Before the script runs it says what the copy in the page is: one scan, with its time.
STATIC_DETAIL = (f"Numbers from the scan published on {WHEN}, after {num(SNAP['scanCycles'])} scan cycles and "
                 f"{num(T['visitsMade'])} site visits.")
SHORT_WHEN = f"{when.day} {when:%b}, {when:%H:%M} UTC"
LC = SNAP.get("lastCycle") or {}

# Jamaica watch: the hourly Jamaica hunt and Jamaican numbers on named scam sites (counts only).
# A snapshot from before the hunt existed has no "jamaica"; then only what the rest of it shows is used.
JM = SNAP.get("jamaica") or {}
JM_AIMED = JM.get("liveAimedAtJamaica", (SNAP.get("byCountry", {}).get("JM") or {}).get("live", 0))
JM_NAMED = JM.get("namedAimedAtJamaica", sum(1 for n in SNAP.get("named", []) if "JM" in (n.get("targets") or [])))


def jm_rows():
    rows = [("Live scam sites aimed at Jamaica", num(JM_AIMED)), ("Named here", num(JM_NAMED))]
    if JM:
        rows.append(("Found by the hunt, watched", f"{num(JM.get('huntWatching'))}: {num(JM.get('huntVisited'))} visited so far, "
                     f"{num(JM.get('huntUp'))} up"))
        rows.append(("Jamaican numbers on named scam sites", f"{num(JM.get('jamaicanNumbers'))}, on {num(JM.get('sitesWithJamaicanNumbers'))} "
                     f"site{'' if JM.get('sitesWithJamaicanNumbers') == 1 else 's'}"))
    return "\n".join(f"          <div><dt>{esc(a)}</dt><dd>{esc(b)}</dd></div>" for a, b in rows)


def jm_hunt():
    last = JM.get("lastHunt")
    if not last:
        return "No Jamaica hunt has finished yet. One starts with each hourly scan run and takes about eight minutes."
    at = datetime.fromisoformat(last["at"].replace("Z", "+00:00")).astimezone(timezone.utc)
    return (f"Last hunt {at.day} {at:%b}, {at:%H:%M} UTC: {num(last.get('searches'))} searches of the scan archive and "
            f"{num(last.get('keywords'))} words checked against the blocklists found {num(last.get('leads'))} leads, "
            f"{num(last.get('suspect'))} of them suspicious and {num(last.get('aimedAtJamaica'))} aimed at Jamaica. "
            f"{num(last.get('added'))} went on the watchlist.")


JM_STATS = jm_rows()
JM_HUNT = esc(jm_hunt())


def cycle_text(c):
    if not c:
        return ""
    parts = [f"{num(c.get('visited'))} sites visited ({num(c.get('up'))} up, {num(c.get('down'))} down)"]
    if c.get("newFromCertificates"):
        parts.append(f"{num(c['newFromCertificates'])} new names from certificate logs")
    if c.get("takedowns"):
        parts.append(f"{num(c['takedowns'])} taken down")
    return "Last cycle: " + ", ".join(parts) + "."


LAST_CYCLE = cycle_text(LC)


def cycle_bars(cycles, slots=60):
    """The per-minute chart, drawn once here from the copy in the page; the script redraws it live."""
    dated = sorted((datetime.fromisoformat(c["at"].replace("Z", "+00:00")), c) for c in cycles if c.get("at"))
    if not dated:
        return "", "", ""
    end = int(dated[-1][0].timestamp() // 60)
    start = end - slots + 1
    by_minute = {int(t.timestamp() // 60): c for t, c in dated}
    peak = max(1, *(c.get("visited", 0) for _, c in dated))
    cols = []
    for minute in range(start, end + 1):
        c = by_minute.get(minute)
        if not c:
            cols.append('<span class="sr-col is-empty"></span>')
            continue
        at = datetime.fromtimestamp(minute * 60, timezone.utc)
        cols.append(f'<span class="sr-col" title="{at:%H:%M} UTC: {num(c.get("visited"))} sites visited, '
                    f'{num(c.get("up"))} up"><i class="sr-col-down" style="height:{100 * c.get("down", 0) / peak:.1f}%"></i>'
                    f'<i class="sr-col-up" style="height:{100 * c.get("up", 0) / peak:.1f}%"></i></span>')
    first = datetime.fromtimestamp(start * 60, timezone.utc)
    last = datetime.fromtimestamp(end * 60, timezone.utc)
    return "".join(cols), f"{first:%H:%M} UTC", f"{last:%H:%M} UTC"


CHART, CHART_FROM, CHART_TO = cycle_bars(SNAP.get("recentCycles") or [])

STATS = [
    ("domainsIndexed", "Domains indexed", "every name it knows"),
    ("worthVisiting", "Worth a visit", "scored 50 or more by spelling and source"),
    ("watched", "Sites watched", "on the watchlist"),
    ("visitsMade", "Visits made", "pages fetched and read"),
    ("liveHighRisk", "Live, high risk", "up now, scoring 60 or more"),
    ("named", "Named", "strong evidence, listed below"),
    ("runningKnownKit", "Known scam kits", "sites running one"),
    ("takenDown", "Taken down", "while being watched"),
]
stats_html = "\n".join(
    f'          <div><dt>{label}</dt><dd data-k="{key}">{num(T.get(key))}</dd><span class="sr-delta" aria-hidden="true"></span><small>{note}</small></div>'
    for key, label, note in STATS)

STATE_WORDS = {"live": "up", "unreachable": "not answering", "offline": "gone from DNS", "blocked": "flagged by their host",
               "parked": "parked", "suspended": "suspended by their host", "seized": "seized", "resolves": "in DNS but not fetched",
               "pending": "still to be finished"}
states = [f"{num(row['sites'])} {STATE_WORDS.get(row['state'], row['state'])}" for row in SNAP.get("states", [])]
STATES = (f"Of {num(T.get('visited'))} sites visited so far: {', '.join(states)}." if states else "")


def bar(n, top):
    return f'<span class="sr-bar" style="--w:{round(100 * n / max(1, top))}%"></span>'


def total(rows):
    return sum(row["live"] for row in rows)


VIEW = "hosts" if total(SNAP["hosts"]) > 4 * total(SNAP["targets"]) else "targets"
view_rows = SNAP[VIEW][:25]
top = max([row["live"] for row in view_rows] or [1])
countries_html = "\n".join(
    f'            <tr><td>{esc(country(row["country"]))}</td><td>{num(row["live"])}</td><td>{bar(row["live"], top)}</td></tr>'
    for row in view_rows) or '            <tr><td colspan="3">None in the latest scan.</td></tr>'
MAP_TITLE = "Where the scams are hosted" if VIEW == "hosts" else "Where the scams are aimed"


def ranking(rows, name, with_country=False):
    rows = rows[:15]
    if not rows:
        return '<li class="sr-empty">None among the live sites in the latest scan.</li>'
    peak = max(row["live"] for row in rows)
    out = []
    for i, row in enumerate(rows, 1):
        where = f'<small>{esc(country(row["country"]))}</small>' if with_country and row.get("country") else ""
        out.append(f'<li><span class="sr-rank">{i}</span><span class="sr-who"><b>{esc(name(row))}</b>{where}</span>'
                   f'<span class="sr-count">{num(row["live"])}</span>{bar(row["live"], peak)}</li>')
    return "".join(out)


LB = SNAP["leaderboards"]
lb_networks = ranking(LB.get("networks", []), lambda r: r["name"], True)
lb_brands = ranking(LB.get("brands", []), lambda r: r["name"], True)
lb_kinds = ranking(LB.get("kinds", []), lambda r: r["name"])
lb_kits = ranking(LB.get("kits", []), lambda r: r["name"])
lb_countries = ranking(LB.get("countries", []), lambda r: country(r["country"]))

batches_html = "\n".join(
    f'            <tr><td>{esc(row["shape"])}</td><td>{num(row["names"])}</td><td>{num(row["timesOverRepresented"])} times</td></tr>'
    for row in SNAP.get("batches", [])) or '            <tr><td colspan="3">No bulk-registered batch stands out among this month&rsquo;s new names.</td></tr>'

NAMED_TOTAL = SNAP.get("namedTotal", len(SNAP.get("named", [])))
hour = SNAP.get("activity", {}).get("hour", {})
ACTIVITY = (f"In the hour before that scan: {num(hour.get('first-visit'))} sites visited for the first time"
            + (f", {num(hour['taken-down'])} takedowns recorded" if hour.get("taken-down") else "") + ".")

# ---------------------------------------------------------------- FAQ
FAQ = [
    ("What is Scam Radar?",
     "Scam Radar is a scanner from CorX Labs that watches the internet for scam and phishing websites as they "
     "appear. It keeps an index of more than 18 million domains, reads newly issued web certificates and newly "
     "registered names, visits the suspicious ones, and records when each goes live, changes or is taken "
     "down. This page shows what it has found, by country, and checks any link you paste into it."),
    ("How do I check a link, an email or a number?",
     "Paste it into the box at the top of the page. A link is judged in your browser with the scanner&rsquo;s "
     "own rules: borrowed brand names, bait words, cheap endings, machine-made names and the marks of a link built "
     "to be passed around. Radar&rsquo;s record for the site, if it has one, is looked up by a scrambled form of "
     "the name. Where this site&rsquo;s scan server is running, a deep dive of up to 40 seconds follows: the page "
     "is visited as plain text and its code is read for 23 scam behaviours, its registration, servers, mail setup "
     "and certificate history are looked up, and the sites that share its server, page title or files are found "
     "and scored. An email address, phone number, Telegram name or crypto wallet is matched, again by a scrambled "
     "form, against the contacts that named scam sites ask people to use. An email address is also checked with "
     "StopForumSpam, and a phone number gets its country and any regulator warning about its area code. You are "
     "never sent to the site."),
    ("How often does it update?",
     "About once a minute. The scanner runs around the clock in one-minute cycles and publishes what it has "
     "found after every cycle, and this page checks for new data every 15 seconds and shows what changed. Once "
     "an hour the scan moves to a fresh GitHub runner, which takes about two minutes, and the page says so "
     "while it happens. It runs on GitHub&rsquo;s servers, so if it stops, the page says how old its numbers "
     "are. No scanner visits millions of sites a second: this one scores 18 million names from their spelling "
     "in seconds, then visits up to 300 of the most suspicious a minute."),
    ("How does it know my country?",
     "From your device&rsquo;s time zone, worked out in your browser. Nothing about you is sent anywhere, and "
     "you can pick another country from the list; the choice is remembered on this device only."),
    ("Is every site listed here certainly a scam?",
     "No tool can promise that. A site is only named here when the evidence is strong: it scores 70 or more "
     "out of 100, and it either runs a scam kit the scanner recognises or is already on a public scam or "
     "phishing blocklist. A suspicious spelling alone is counted in the country totals but never named. "
     "If you think a site is listed by mistake, email lkk89002@gmail.com and it will be checked."),
    ("What is shown about a scam site?",
     "Its name, written so it can&rsquo;t be clicked, and its page title with any phone numbers, emails and "
     "links removed. Everything else is in the scanner&rsquo;s own words: the kind of scam, the kit, the brand "
     "it copies, why it scored what it did, where it is hosted and when it was first seen. Page text, contact "
     "details, wallets and code are never shown, because a contact on a scam page is often someone "
     "else&rsquo;s hijacked account."),
    ("What do the countries mean?",
     "Hosted in is the country of the server, when that can be seen. Many scam sites hide behind networks such "
     "as Cloudflare, and for those the server&rsquo;s country is not shown. It is never guessed. Aimed at is "
     "the country a scam targets, worked out from the brand it impersonates, the currency or flag in its "
     "title, or the language it uses. Most scam sites aim at nobody in particular, so far fewer have one."),
    ("I got a scam link. What should I do?",
     "Don&rsquo;t open it and don&rsquo;t enter anything. If it uses your bank&rsquo;s or a company&rsquo;s name, "
     "tell that company through its official number or website. You can report the link to Google Safe "
     "Browsing so browsers warn other people, and to the police if you lost money."),
    ("Who built it?",
     "<a href=\"/nathan/\">Nathan Lyttle</a>, the founder of CorX Labs, as Scam Finder: a tool that starts from "
     "one scam link and maps the operation behind it, and Radar, the part that keeps scanning. It "
     "started from a real WhatsApp &ldquo;gift&rdquo; scam that used a Jamaican brand&rsquo;s name."),
]
faq_html = "\n".join(f"""        <details>
          <summary>{q}{PLUS}</summary>
          <div class="faq-body"><p>{a}</p></div>
        </details>""" for q, a in FAQ)

person = {"@type": "Person", "@id": "https://www.corx-labs.com/#nathan", "name": "Nathan Lyttle", "url": "https://www.corx-labs.com/nathan/"}
graph = [
    {"@type": "WebApplication", "@id": URL + "#app", "name": "Scam Radar", "url": URL,
     "applicationCategory": "SecurityApplication", "operatingSystem": "Any (web browser)",
     "description": "A scam and phishing website checker and live map. Paste a link to see what its address gives "
                    "away, what the scanner has on record for it and what its page does. The map shows scam "
                    "websites by the country that hosts them and the country they target, from a scanner that "
                    "watches more than 18 million domains, newly issued certificates and newly registered names, "
                    "and records when each scam site goes live or is taken down.",
     "featureList": ["Check a link or domain for scam signals", "Deep dive into a site: registration, servers, mail, certificates and linked sites",
                     "Check an email address, phone number, Telegram name or crypto wallet against named scam sites",
                     "Hourly hunt for scam sites aimed at Jamaica", "Live scam websites by country", "Live feed of new scam sites and takedowns",
                     "Leaderboards of faked brands, scam kinds, scam kits and hosting networks", "3D map of scam campaigns"],
     "isAccessibleForFree": True, "image": OG, "author": person,
     "publisher": {"@id": "https://www.corx-labs.com/#organization"}, "datePublished": PUBLISHED, "dateModified": DATE,
     "offers": {"@type": "Offer", "price": "0", "priceCurrency": "USD", "availability": "https://schema.org/InStock"},
     "countryOfOrigin": {"@type": "Country", "name": "Jamaica"}},
    {"@type": "WebPage", "@id": URL + "#webpage", "url": URL, "name": "Scam Radar: live scam websites by country",
     "isPartOf": {"@id": "https://www.corx-labs.com/#website"}, "mainEntity": {"@id": URL + "#app"},
     "inLanguage": "en", "datePublished": PUBLISHED, "dateModified": DATE,
     "breadcrumb": {"@id": URL + "#breadcrumb"}},
    {"@type": "BreadcrumbList", "@id": URL + "#breadcrumb", "itemListElement": [
        {"@type": "ListItem", "position": 1, "name": "Home", "item": "https://www.corx-labs.com/"},
        {"@type": "ListItem", "position": 2, "name": "Scam Radar", "item": URL}]},
    {"@type": "FAQPage", "@id": URL + "#faq", "isPartOf": {"@id": URL + "#webpage"},
     "mainEntity": [{"@type": "Question", "name": q, "acceptedAnswer": {"@type": "Answer", "text": plain(a)}}
                    for q, a in FAQ]},
]
ld = json.dumps({"@context": "https://schema.org", "@graph": graph}, ensure_ascii=False, indent=2)
assert "</" not in ld

DESC = "Check any link for scam signals, and see live scam and phishing websites by country, from a scanner watching 18 million domains. Updated by itself."
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
<meta property="og:description" content="Paste a link to check it. See which countries scam websites are hosted in and aimed at right now, from a scanner that watches 18 million domains and records every takedown.">
<meta property="og:image" content="{OG}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:image:alt" content="Scam Radar — live scam websites by country">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:site" content="@corxlabs">
<meta name="twitter:title" content="Scam Radar — live scam websites by country">
<meta name="twitter:description" content="Paste a link to check it. See which countries scam websites are hosted in and aimed at right now, and which ones were taken down.">
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
      <span class="tag tag-live" id="sr-live-tag"><i class="dot" aria-hidden="true"></i> <span id="sr-age">Scan of {SHORT_WHEN}</span></span>
      <span class="tag">Scam &amp; phishing sites</span>
      <span class="tag">Every country</span>
      <span class="tag">New data every minute</span>
    </div>
    <h1>Scam Radar</h1>
    <p class="lede">Scam websites going up right now, where they are hosted and which countries they aim at. A
      scanner watches more than 18 million domains and visits the suspicious ones around the clock. Paste any
      link to check it.</p>
  </div>

  <section class="section-tight" id="live" aria-label="The scanner right now" style="padding-top:clamp(22px,3.4vw,40px)">
    <div class="shell">
      <div class="sr-console" id="sr-console" data-mode="static">
        <div class="sr-console-head">
          <p class="sr-console-state"><i class="sr-pulse" aria-hidden="true"></i><b id="sr-live-state">Last scan</b>
            <span id="sr-live-detail">{STATIC_DETAIL}</span></p>
          <a class="sr-console-link" href="/scam-radar/map/">Open the live map <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6"/></svg></a>
        </div>
        <dl class="sr-stats sr-stats-8" id="sr-stats">
{stats_html}
        </dl>
        <p class="sr-note sr-states" id="sr-states">{STATES}</p>
        <div class="sr-console-body">
          <figure class="sr-cycles">
            <figcaption><b>Sites visited, minute by minute</b><span><i class="sr-key-up"></i> up <i class="sr-key-down"></i> down</span></figcaption>
            <div class="sr-cycles-chart" id="sr-cycles-chart" role="img" aria-label="Sites visited in each scan cycle over the last hour">{CHART}</div>
            <div class="sr-cycles-axis" aria-hidden="true"><span id="sr-cycles-from">{CHART_FROM}</span><span id="sr-cycles-to">{CHART_TO}</span></div>
            <p class="sr-cycle-now" id="sr-cycle-now">{LAST_CYCLE}</p>
          </figure>
          <div class="sr-console-latest" id="sr-console-latest" hidden>
            <p class="sr-console-label">Latest on named sites</p>
            <ol class="sr-console-feed" id="sr-console-feed"></ol>
          </div>
        </div>
      </div>
    </div>
  </section>

  <section class="section-tight" id="check" style="padding-top:clamp(28px,4vw,48px)">
    <div class="shell">
      <div class="sr-card">
        <h2>Check a link, an email or a number</h2>
        <p class="sr-note">Paste a link, a domain, an email address, a phone number, a Telegram name or a crypto
          wallet from a message you don&rsquo;t trust. You are never sent to the site.</p>
        <ul class="sr-check-kinds">
          <li><strong>A link</strong> gets what its address gives away and Radar&rsquo;s record for the site. Where
            this site&rsquo;s scan server is running, a deep dive of up to 40 seconds follows: the page is visited
            as text and read for 23 scam behaviours, its registration, servers, mail setup and certificate history
            are looked up, and the sites that share its server, page title or files are found and scored.</li>
          <li><strong>A contact</strong> gets the named scam sites that asked people to use it. An email address is
            also checked with StopForumSpam. A phone number gets its country and any regulator warning about its
            area code.</li>
        </ul>
        <form class="sr-check-form" id="sr-check" action="/scam-radar/" method="get" autocomplete="off">
          <label class="visually-hidden" for="sr-check-input">Link, domain, email address, phone number or wallet to check</label>
          <input id="sr-check-input" name="check" type="text" autocapitalize="off" spellcheck="false"
            maxlength="2048" placeholder="example.buzz/abc123 or name@example.com" required>
          <button class="btn btn-primary" type="submit">Check</button>
        </form>
        <div class="sr-check-result" id="sr-check-result" aria-live="polite"></div>
        <p class="sr-note">A link&rsquo;s address is judged in your browser. Radar&rsquo;s records are looked up by a
          scrambled form of the name or contact, so what you typed is not sent. A deep dive sends the link to this
          site&rsquo;s server, which fetches the page as text, asks public records about the site and keeps nothing.
          An email address or phone number is sent to the same server, which keeps nothing. An email address is
          passed on to StopForumSpam for its spam check.</p>
      </div>
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
        <div id="sr-home-body"><p class="sr-note">Choose your country to see the scams aimed at it and the scam
          sites hosted in it.</p></div>
        <p class="sr-note">Your country is guessed from your device&rsquo;s time zone, in your browser. Nothing is sent anywhere.</p>
      </div>
    </div>
  </section>

  <section class="section-tight" id="jamaica" style="padding-top:0">
    <div class="shell">
      <div class="sr-card">
        <h2>Jamaica watch</h2>
        <p class="sr-note">Every hour Radar hunts for scam sites aimed at Jamaica. It looks for copies of Jamaican
          banks, telecoms and agencies on other domains, pages that pair Jamaica with prize, grant or sign-in
          wording, holiday giveaway kits, and lottery-winner and advance-fee pages. It searches urlscan.io&rsquo;s
          public scan archive and the blocklists, visits the most suspicious and puts them on the watchlist. A site
          is named only on its own strong evidence. Being Jamaican never makes a site suspect.</p>
        <dl class="sr-facts" id="sr-jm-stats">
{JM_STATS}
        </dl>
        <p class="sr-note" id="sr-jm-hunt">{JM_HUNT}</p>
        <p class="sr-note">Got a call or a WhatsApp message from an 876 or 658 number about a prize, a grant or your
          bank? Paste the number into the <a href="#check">checker</a>. Those area codes dial like US numbers, and
          they feature in regulator warnings about lottery and callback scams. Numbers found on named scam sites
          are counted here, never shown.</p>
        <button class="btn btn-ghost btn-sm" type="button" id="sr-jm-named">Show named sites aimed at Jamaica</button>
      </div>
    </div>
  </section>

  <section class="section-tight" id="map" style="padding-top:0">
    <div class="shell">
      <h2 id="sr-map-title-text">{MAP_TITLE}</h2>
      <div class="sr-card mt-m">
        <div class="sr-toggle" role="radiogroup" aria-label="Which country to map">
          <input class="sr-radio" type="radio" name="sr-view" id="sr-view-hosts" value="hosts"{' checked' if VIEW == 'hosts' else ''}>
          <label for="sr-view-hosts">Hosted in</label>
          <input class="sr-radio" type="radio" name="sr-view" id="sr-view-targets" value="targets"{' checked' if VIEW == 'targets' else ''}>
          <label for="sr-view-targets">Aimed at</label>
        </div>
        <div class="sr-map-wrap">{MAP}</div>
        <div class="sr-legend" aria-hidden="true"><span>Fewer</span><i></i><i></i><i></i><i></i><i></i><span>More live scam sites</span></div>
        <p class="sr-note" id="sr-map-note">Countries are shaded by how many live, high-risk scam sites they hold.</p>
      </div>
      <div class="table-wrap mt-m">
        <table class="sr-table" id="sr-countries">
          <caption class="visually-hidden">Live high-risk scam sites by country</caption>
          <thead><tr><th scope="col">Country</th><th scope="col">Live scam sites</th><th scope="col" aria-label="Share of the busiest country"></th></tr></thead>
          <tbody>
{countries_html}
          </tbody>
        </table>
      </div>
    </div>
  </section>

  <section class="section-tight" id="feed" style="padding-top:0">
    <div class="shell">
      <h2>What just happened</h2>
      <div class="prose"><p>Named sites going live, changing and being taken down, newest first. Click a name to
        check it.</p></div>
      <p class="sr-note" id="sr-activity">{ACTIVITY}</p>
      <div class="sr-card sr-feed-wrap"><ul class="sr-feed" id="sr-feed" hidden></ul>
        <noscript><p class="sr-note">The feed needs JavaScript: site names are never written into this page, only drawn in your browser.</p></noscript></div>
    </div>
  </section>

  <section class="section-tight" id="leaderboard" style="padding-top:0">
    <div class="shell">
      <h2>Leaderboard</h2>
      <div class="prose"><p>Counted over every live, high-risk scam site in the latest scan.</p></div>
      <div class="sr-board mt-m">
        <input class="sr-radio" type="radio" name="sr-lb" id="sr-lb-1" checked>
        <input class="sr-radio" type="radio" name="sr-lb" id="sr-lb-2">
        <input class="sr-radio" type="radio" name="sr-lb" id="sr-lb-3">
        <input class="sr-radio" type="radio" name="sr-lb" id="sr-lb-4">
        <input class="sr-radio" type="radio" name="sr-lb" id="sr-lb-5">
        <div class="sr-toggle sr-lb-tabs" aria-hidden="true">
          <label for="sr-lb-1">Hosting networks</label>
          <label for="sr-lb-2">Most faked brands</label>
          <label for="sr-lb-3">Kinds of scam</label>
          <label for="sr-lb-4">Scam kits</label>
          <label for="sr-lb-5">Countries aimed at</label>
        </div>
        <div class="sr-card sr-lb sr-lb-p1"><h3 class="visually-hidden">Hosting networks with the most live scam sites</h3>
          <ol class="sr-rankings" id="sr-lb-networks">{lb_networks}</ol>
          <p class="sr-note">A network that hosts a scam site has usually not chosen to. Reporting the site to the
            network&rsquo;s abuse team is often the fastest way to get it taken down.</p></div>
        <div class="sr-card sr-lb sr-lb-p2"><h3 class="visually-hidden">Most faked brands</h3><ol class="sr-rankings" id="sr-lb-brands">{lb_brands}</ol></div>
        <div class="sr-card sr-lb sr-lb-p3"><h3 class="visually-hidden">Kinds of scam</h3><ol class="sr-rankings" id="sr-lb-kinds">{lb_kinds}</ol>
          <p class="sr-note">Only sites whose kit, code or wording says what they are. Most blocklisted sites show a
            bare sign-in page and are left unclassified.</p></div>
        <div class="sr-card sr-lb sr-lb-p4"><h3 class="visually-hidden">Most copied scam kits</h3><ol class="sr-rankings" id="sr-lb-kits">{lb_kits}</ol></div>
        <div class="sr-card sr-lb sr-lb-p5"><h3 class="visually-hidden">Countries scams are aimed at</h3><ol class="sr-rankings" id="sr-lb-countries">{lb_countries}</ol></div>
      </div>
    </div>
  </section>

  <section class="section-tight" id="named" style="padding-top:0">
    <div class="shell">
      <h2>Live scam sites with strong evidence</h2>
      <div class="prose">
        <p>Only sites that run a scam kit the scanner recognises, or that are already on a public scam or
          phishing blocklist, are named. Names are written so they can&rsquo;t be clicked: <code>example[.]com</code>.
          Don&rsquo;t visit them. Click a name to see its full record.</p>
      </div>
      <div class="sr-named-tools">
        <label class="visually-hidden" for="sr-named-filter">Filter the named sites</label>
        <input id="sr-named-filter" type="search" placeholder="Filter by name, brand, kit or country" autocomplete="off">
        <p id="sr-named-count">{num(NAMED_TOTAL)} live sites met the bar in the scan published on {WHEN}.</p>
      </div>
      <div class="table-wrap mt-s">
        <table class="sr-table" id="sr-named">
          <caption class="visually-hidden">Live scam sites named with their evidence</caption>
          <thead><tr><th scope="col">Site</th><th scope="col">What it is</th><th scope="col">Evidence</th><th scope="col">Where</th><th scope="col">First seen</th></tr></thead>
          <tbody><tr><td colspan="5">The list is drawn from the latest scan when the page loads.</td></tr></tbody>
        </table>
      </div>
      <button class="btn btn-ghost btn-sm sr-more" id="sr-named-more" type="button" hidden>Show more</button>
    </div>
  </section>

  <section class="section-tight" id="takedowns" style="padding-top:0">
    <div class="shell">
      <h2>Taken down this week</h2>
      <ul class="sr-downs mt-s" id="sr-downs"><li>{num(T.get('takenDown'))} watched sites had been taken down by {WHEN}. A takedown is recorded when a site that was up fails two visits in a row.</li></ul>
    </div>
  </section>

  <section class="section-tight" id="batches" style="padding-top:0">
    <div class="shell">
      <h2>Names registered in bulk</h2>
      <div class="prose"><p>Throwaway scam domains are registered by script, so they share a mould: five random
        letters and <code>.buzz</code>, say. These moulds are far more common among this month&rsquo;s new names than
        across the established web. {num(T.get('inBulkBatches'))} names fit one. Most are never used; the ones
        that go live are visited first.</p></div>
      <div class="table-wrap mt-m">
        <table class="sr-table" id="sr-batches">
          <caption class="visually-hidden">Bulk-registration moulds among newly registered names</caption>
          <thead><tr><th scope="col">Mould</th><th scope="col">New names</th><th scope="col">More common than on the established web</th></tr></thead>
          <tbody>
{batches_html}
          </tbody>
        </table>
      </div>
      <div class="sr-card sr-mapcta mt-m">
        <div><h3>The map</h3>
          <p>Every named site on a globe you can turn, grouped into campaigns that show the same lure, with the
            fingerprints they share. Paste a link there to trace the sites connected to it.</p></div>
        <a class="btn btn-primary" href="/scam-radar/map/">Open the map</a>
      </div>
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
        <li><div><h3>The suspicious ones, visited</h3><p>The highest-scoring names go on a watchlist, with new sites
          that borrow a brand&rsquo;s name at the front. A dead site is settled by one DNS answer; a live one is
          fetched as plain text, never run, and its code is checked for 23 scam behaviours, from passwords sent
          to a Telegram bot to wallet-draining approvals.</p></div></li>
        <li><div><h3>Watched until they go</h3><p>Live high-risk sites are revisited every half hour to two hours.
          When one stops answering twice in a row, the takedown is recorded with when and why: gone from DNS,
          suspended by the registrar, or flagged by its host.</p></div></li>
        <li><div><h3>Published every minute</h3><p>The scanner runs around the clock in one-minute cycles, up to
          300 site visits each, and publishes what it has found after every cycle. This page checks for new data
          every 15 seconds and shows what changed. Nobody edits the list by hand.</p></div></li>
      </ol>
      <div class="callout mt-m">
        <p><strong>What it can&rsquo;t tell you.</strong> How many people clicked: only the scammers know. Who is
          behind a site: it maps servers and registrations, not people. And it can be wrong, which is why a site is
          only named on strong evidence, and why a score is a reason to look and not a verdict. If you think a
          site is listed by mistake, email <a href="mailto:lkk89002@gmail.com">lkk89002@gmail.com</a>.</p>
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
        Transparency logs and newly registered domain lists. Map: Natural Earth. The numbers written into this page
        are from the scan published on {WHEN}; the page replaces them with the latest when it loads.</p>
    </div>
  </section>
</main>

{footer}

<script src="/assets/js/scam-finder-core.js" defer></script>
<script src="/assets/js/scam-radar.js" defer></script>
<script src="/assets/js/main.js" defer></script>
</body>
</html>
"""
OUT.parent.mkdir(parents=True, exist_ok=True)
OUT.write_text(page, encoding="utf-8")
print("wrote", OUT, f"{len(page) // 1024} KB,", len(paths), "countries on the map;",
      f"numbers from the scan of {WHEN}; map opens on '{VIEW}'")
