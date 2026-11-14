#!/usr/bin/env python3
"""Generate models/pluvium/index.html:  python3 tools/build-pluvium-page.py

The visible FAQ and the FAQPage JSON-LD come from the same list, so their text
cannot drift apart. Masthead, the "also from" card and the footer are copied
from the NatureV1 page so the chrome stays identical to the rest of the site.

Every claim comes from the committed Pluvium docs (README, ARCHITECTURE,
OPERATIONAL_BENCHMARK, BENCHMARK, FAILURE_MODES at commit 272a0c3) except the
six-region note, which is labelled as early and unpublished. The scorecard (charts and
comparison table) comes from tools/pluvium_scorecard.py.
"""
import html
import json
import re
import sys
from pathlib import Path

ROOT = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).resolve().parent.parent
sys.path.insert(0, str(Path(__file__).resolve().parent))
import pluvium_scorecard as sc  # noqa: E402
SRC = (ROOT / "models/naturev1/index.html").read_text(encoding="utf-8")
OUT = ROOT / "models/pluvium/index.html"

URL = "https://corx-labs.com/models/pluvium/"
PYPI = "https://pypi.org/project/pluvium/"
OG = "https://corx-labs.com/assets/img/og-pluvium.jpg"
DATE = "2026-11-14"
ODPEM = '<a href="https://www.odpem.org.jm/" rel="noopener nofollow" target="_blank">ODPEM</a>'
EXT = ('<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" '
       'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 17 17 7M9 7h8v8"/></svg>')
PLUS = ('<span class="plus" aria-hidden="true"><svg viewBox="0 0 24 24" width="12" height="12" fill="none" '
        'stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg></span>')


def plain(fragment: str) -> str:
    """Visible text of an HTML fragment, whitespace collapsed."""
    return re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]+>", "", fragment))).strip()


def block(start: str, end: str) -> str:
    i = SRC.index(start)
    j = SRC.index(end, i) + len(end)
    return SRC[i:j]


# ---------------------------------------------------------------- chrome
masthead = block('<header class="masthead">', "</header>")
masthead = masthead.replace(
    '<a class="btn btn-primary btn-sm" href="https://huggingface.co/Sigmandndnns/NatureV1-500" rel="noopener" target="_blank">Hugging Face</a>',
    f'<a class="btn btn-primary btn-sm" href="{PYPI}" rel="noopener" target="_blank">View on PyPI</a>')
masthead = masthead.replace(
    '<a class="btn btn-primary" href="https://huggingface.co/Sigmandndnns/NatureV1-500" rel="noopener" target="_blank">View on Hugging Face</a>',
    f'<a class="btn btn-primary" href="{PYPI}" rel="noopener" target="_blank">View on PyPI</a>')
assert "huggingface" not in masthead and masthead.count(PYPI) == 2, "masthead CTA not replaced"
assert '<a href="/models/" aria-current="page">Our Products</a>' in masthead

also = block('<section class="section-tight also-from"', "</section>")
footer = block('<footer class="site-footer">', "</footer>")
nv_li = '<li><a href="/models/naturev1/">NatureV1</a></li>'
assert footer.count(nv_li) == 1
if '/models/pluvium/' not in footer:   # the NatureV1 footer already lists Pluvium once the site links it
    footer = footer.replace(nv_li, nv_li + '\n          <li><a href="/models/pluvium/">Pluvium</a></li>')

# ---------------------------------------------------------------- FAQ (one source)
FAQ = [
    ("What is Pluvium?",
     "Pluvium is an open-source AI rain-forecasting system built by CorX Labs in Jamaica and released "
     "under Apache-2.0. For every town and village in the Caribbean it forecasts rain hour by hour for "
     "three days: the chance of rain, whether it will be drizzle, showers, heavy rain or a thunderstorm, "
     "when it will most likely start, how long it will last and how much will fall. Pluvium Blend adds "
     "daily rain chances out to 14 days. It is a research model, not an official forecast."),
    ("Is Pluvium an official forecast?",
     "<strong>No.</strong> It is a research model that no independent party has verified, and its flood "
     "levels are a rule that has not been checked against flood reports. Do not use it for real "
     "decisions. Follow your national meteorological service; in Jamaica, the Meteorological Service of "
     f"Jamaica and {ODPEM}."),
    ("How accurate is Pluvium?",
     "On 450 land cells covering Jamaica in July and August 2025, with a protocol frozen before the data "
     "were downloaded, Pluvium had the highest Brier skill of any single system for rain of at least "
     "1&nbsp;mm on days 1 and 2: +0.127 and +0.118, against +0.087 and +0.091 for the best of the six "
     "operational systems (ECMWF ENS, HRES and AIFS, and NOAA GEFS, GraphCast and GFS). With 95% confidence it beat ENS and HRES on all three days "
     "and AIFS and GraphCast on days 1 and 2; against GEFS and GFS its lead was not significant. In May "
     "and June 2025 it lost after calibration, because of a wet April it had never trained on. At 25 and "
     "50&nbsp;mm no system beat a forecast that never says rain."),
    ("Can Pluvium forecast rain in my country?",
     "It can be set up for any country between 60&deg;&nbsp;S and 60&deg;&nbsp;N, because nothing in it is "
     "tied to Jamaica. <code>pluvium setup --country</code> with an ISO code builds the area, terrain, "
     "provinces and every town, and Pluvium Blend can be trained for it from a year of archived runs: "
     "about two hours of downloads and under an hour of CPU. It has been set up and tested from live data "
     "in Jamaica, Trinidad and Tobago, Sri Lanka and Ghana, with bulletins in English, Spanish, French and "
     "Jamaican Patois. Its skill in a new country is unknown until it is scored there."),
    ("What is Pluvium Blend?",
     "Pluvium Blend combines six operational systems (ECMWF ENS, HRES and AIFS, and NOAA GEFS, GraphCast "
     "and GFS), plus Pluvium&rsquo;s own network where it runs, into one calibrated forecast of each "
     "day&rsquo;s rain out to 14 days. Each system is first post-processed on its own by a small network; "
     "then a pool of about 70 weights, fitted on weeks the components never trained on, combines them. "
     "Because every rival gets the same post-processing, the blend has to beat each system&rsquo;s best "
     "version, not just its raw output."),
    ("How is Pluvium related to NatureV1?",
     "Pluvium runs on the same engine as <a href=\"/models/naturev1/\">NatureV1</a>: iHELIX, whose "
     "attention heads have physical radii in kilometres on the sphere. NatureV1 forecasts the whole "
     "atmosphere and hurricanes on a 1.5&deg; global grid. Pluvium uses the engine on a Caribbean mesh of "
     "6,075 points, about 11&nbsp;km apart over land, with physics such as mountain rain and sea-breeze "
     "convergence built in, to forecast the rain at each town hour by hour."),
    ("Is Pluvium free and open source?",
     "Yes. The code is released under the Apache-2.0 licence, which allows commercial use, and installs "
     "with <code>pip install pluvium</code>. The weights of the full-size model, Pluvium-500, have not been "
     "published yet; the results on this page come from the small model, pluvium-small. The data it "
     "learns from has its own terms, credited on this page."),
    ("Who built Pluvium?",
     "Pluvium was built by <a href=\"/nathan/\">Nathan Lyttle</a>, the founder of CorX Labs and a solo "
     "developer from Jamaica, who also built NatureV1 and its iHELIX engine."),
]

faq_html = "\n".join(
    f"""        <details>
          <summary>{q}{PLUS}</summary>
          <div class="faq-body"><p>{a}</p></div>
        </details>""" for q, a in FAQ)

# ---------------------------------------------------------------- JSON-LD
person = {"@type": "Person", "@id": "https://corx-labs.com/#nathan", "name": "Nathan Lyttle",
          "url": "https://corx-labs.com/nathan/"}
graph = [
    {
        "@type": ["SoftwareApplication", "SoftwareSourceCode"],
        "@id": URL + "#model",
        "name": "Pluvium",
        "alternateName": ["pluvium", "Pluvium-500", "Pluvium Blend"],
        "url": URL,
        "image": OG,
        "description": (
            "Pluvium is an open-source probabilistic rain forecasting system from CorX Labs, made in Jamaica "
            "and released under Apache-2.0 as a research model rather than an official forecast. For every "
            "town and village in the Caribbean it forecasts rain hour by hour for three days: the chance of "
            "rain, whether it will be drizzle, showers, heavy rain or a thunderstorm, when it will most likely "
            "start, how long it will last, how much will fall, lightning nearby and a flood-risk rule. It runs "
            "on the NatureV1 / iHELIX engine over a 6,075-point Caribbean mesh with physics such as orographic "
            "rain and sea-breeze convergence built in, and one chain of rain states per town keeps every timing "
            "and amount answer consistent. Pluvium Blend pools the post-processed forecasts of six operational "
            "systems into daily rain chances out to 14 days. On 450 land cells covering Jamaica in July and "
            "August 2025 the small model had the highest Brier skill for rain of at least 1 mm on days 1 and 2 "
            "against ECMWF ENS, HRES and AIFS and NOAA GEFS, GraphCast and GFS; in May and June 2025 it lost "
            "after calibration."),
        "applicationCategory": "DeveloperApplication",
        "applicationSubCategory": "Rain forecasting model",
        "operatingSystem": "OS Independent",
        "softwareVersion": "0.1.0",
        "programmingLanguage": "Python",
        "runtimePlatform": "PyTorch",
        "codeRepository": PYPI,
        "downloadUrl": PYPI,
        "installUrl": PYPI,
        "softwareRequirements": "Python >= 3.10, PyTorch >= 2.5",
        "isAccessibleForFree": True,
        "offers": {"@type": "Offer", "price": "0", "priceCurrency": "USD",
                   "availability": "https://schema.org/InStock"},
        "datePublished": DATE,
        "dateModified": DATE,
        "inLanguage": "en",
        "license": "https://www.apache.org/licenses/LICENSE-2.0",
        "author": person,
        "creator": {"@id": "https://corx-labs.com/#nathan"},
        "publisher": {"@id": "https://corx-labs.com/#organization"},
        "provider": {"@id": "https://corx-labs.com/#organization"},
        "countryOfOrigin": {"@type": "Country", "name": "Jamaica"},
        "keywords": ("Caribbean rain forecast, Jamaica rain forecast, AI rain forecast, hourly rain forecast, "
                     "Jamaican AI weather model, precipitation forecasting, probabilistic forecasting, "
                     "post-processing, nowcasting, orographic precipitation, hidden Markov model, "
                     "geodesic attention, ECMWF, GFS, GraphCast, AIFS, CMORPH, PyTorch"),
        "featureList": [
            "Hour-by-hour rain for every town and village in the Caribbean, three days ahead",
            "The chance of rain each hour, and whether it is drizzle, showers, steady rain, heavy rain or a thunderstorm",
            "The most likely start hour in local time with a window, the heaviest hour and how long rain will last",
            "24-hour totals as a median and a 90th percentile, with the chance of 10, 25, 50 and 100 mm",
            "One 4 x 4 chain of rain states per town and hour, so every timing and amount answer is consistent",
            "Physics computed rather than learned: Smith-Barstad orographic rain, island sea-breeze convergence, fronts and the rain now carried along the steering wind",
            "Trained through each instrument's learned confusion matrix, a differentiable hidden Markov model",
            "Pluvium Blend: six operational systems, each post-processed on its own, pooled with about 70 out-of-fold weights into daily rain chances out to 14 days",
            "Any country between 60 S and 60 N with one setup command; bulletins in English, Spanish, French and Jamaican Patois",
            "Lightning within 10 km of each town from the GOES Geostationary Lightning Mapper",
            "Input repair, drift detection, a statistical fallback and atomic publishing in operation",
        ],
        "sameAs": [PYPI],
        "about": [
            {"@type": "Thing", "name": "Weather forecasting",
             "sameAs": "https://en.wikipedia.org/wiki/Weather_forecasting"},
            {"@type": "Thing", "name": "Quantitative precipitation forecast",
             "sameAs": "https://en.wikipedia.org/wiki/Quantitative_precipitation_forecast"},
            {"@type": "Place", "name": "Caribbean", "sameAs": "https://en.wikipedia.org/wiki/Caribbean"},
        ],
        "locationCreated": {"@type": "Place", "name": "Jamaica", "sameAs": "https://en.wikipedia.org/wiki/Jamaica"},
        "isBasedOn": {"@id": "https://corx-labs.com/models/naturev1/#model"},
        "isPartOf": {"@id": "https://corx-labs.com/models/#list"},
    },
    {
        "@type": "WebPage",
        "@id": URL + "#webpage",
        "url": URL,
        "name": "Pluvium — AI Rain Forecasts for Every Caribbean Town",
        "isPartOf": {"@id": "https://corx-labs.com/#website"},
        "mainEntity": {"@id": URL + "#model"},
        "primaryImageOfPage": {"@type": "ImageObject", "url": OG, "width": 1200, "height": 630},
        "inLanguage": "en",
        "datePublished": DATE,
        "dateModified": DATE,
        "breadcrumb": {"@id": URL + "#breadcrumb"},
        "speakable": {"@type": "SpeakableSpecification", "cssSelector": [".answer-box"]},
    },
    {
        "@type": "BreadcrumbList",
        "@id": URL + "#breadcrumb",
        "itemListElement": [
            {"@type": "ListItem", "position": 1, "name": "Home", "item": "https://corx-labs.com/"},
            {"@type": "ListItem", "position": 2, "name": "Our Products", "item": "https://corx-labs.com/models/"},
            {"@type": "ListItem", "position": 3, "name": "Pluvium", "item": URL},
        ],
    },
    {
        "@type": "TechArticle",
        "@id": URL + "#article",
        "headline": "Pluvium: open-source, hour-by-hour rain forecasts for every Caribbean town",
        "image": OG,
        "mainEntityOfPage": {"@id": URL + "#webpage"},
        "about": {"@id": URL + "#model"},
        "author": person,
        "publisher": {"@id": "https://corx-labs.com/#organization"},
        "datePublished": DATE,
        "dateModified": DATE,
        "inLanguage": "en",
        "isPartOf": {"@id": URL + "#webpage"},
        "proficiencyLevel": "Expert",
    },
    {
        "@type": "FAQPage",
        "@id": URL + "#faq",
        "isPartOf": {"@id": URL + "#webpage"},
        "mainEntity": [
            {"@type": "Question", "name": q, "acceptedAnswer": {"@type": "Answer", "text": plain(a)}}
            for q, a in FAQ
        ],
    },
]
ld = json.dumps({"@context": "https://schema.org", "@graph": graph}, ensure_ascii=False, indent=2)
assert "</" not in ld

# ---------------------------------------------------------------- head
HEAD = """<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">

<title>Pluvium — AI Rain Forecasts for Every Caribbean Town | CorX Labs</title>
<meta name="description" content="Pluvium is an open-source AI rain forecast made in Jamaica: hour by hour for every Caribbean town — when rain starts, how long, how much. A research model.">
<link rel="canonical" href="https://corx-labs.com/models/pluvium/">

<meta name="robots" content="index, follow, max-snippet:-1, max-image-preview:large, max-video-preview:-1">
<meta name="author" content="Nathan Lyttle">
<meta name="theme-color" content="#f4f2ec" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#14100c" media="(prefers-color-scheme: dark)">
<meta name="color-scheme" content="light dark">
<link rel="alternate" hreflang="en" href="https://corx-labs.com/models/pluvium/">
<link rel="alternate" hreflang="x-default" href="https://corx-labs.com/models/pluvium/">

<meta property="og:type" content="article">
<meta property="og:site_name" content="CorX Labs">
<meta property="og:locale" content="en_US">
<meta property="og:url" content="https://corx-labs.com/models/pluvium/">
<meta property="og:title" content="Pluvium — hour-by-hour rain forecasts for every Caribbean town">
<meta property="og:description" content="An open-source AI rain model made in Jamaica: will it rain, when it starts, how long it lasts and how much falls, hour by hour for every town. Tested against ECMWF and NOAA on real archived forecasts. A research model, not a forecast.">
<meta property="og:image" content="https://corx-labs.com/assets/img/og-pluvium.jpg">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:image:alt" content="Pluvium — rain, hour by hour, town by town. An open-source rain model made in Jamaica">
<meta property="article:published_time" content="2026-11-14T00:00:00Z">
<meta property="article:modified_time" content="2026-11-14T00:00:00Z">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:site" content="@corxlabs">
<meta name="twitter:title" content="Pluvium — hour-by-hour rain forecasts for every Caribbean town">
<meta name="twitter:description" content="Rain for every Caribbean town, hour by hour, three days ahead, and Pluvium Blend out to 14 days. Open source, made in Jamaica, scored against ECMWF and NOAA. A research model.">
<meta name="twitter:image" content="https://corx-labs.com/assets/img/og-pluvium.jpg">
<meta name="twitter:image:alt" content="Pluvium — rain, hour by hour, town by town. An open-source rain model made in Jamaica">

<link rel="icon" href="/favicon.ico" sizes="32x32">
<link rel="icon" href="/assets/img/icon-192.png" type="image/png" sizes="192x192">
<link rel="apple-touch-icon" href="/assets/img/apple-touch-icon.png">
<link rel="manifest" href="/site.webmanifest">
<link rel="alternate" type="application/rss+xml" title="CorX Labs — model releases" href="/feed.xml">

<link rel="preload" href="/assets/fonts/inter-latin.3100e775.woff2" as="font" type="font/woff2" crossorigin>
<link rel="preload" href="/assets/fonts/cormorant-garamond-latin.d80df8ff.woff2" as="font" type="font/woff2" crossorigin>
<link rel="stylesheet" href="/assets/css/main.css">
<link rel="stylesheet" href="/assets/css/scorecard.css">
<style>html{background:#f4f2ec}@media(prefers-color-scheme:dark){html{background:#14100c}}</style>

<script type="application/ld+json">
@@LD@@
</script>
</head>
<body>
<a class="skip-link" href="#main">Skip to content</a>

"""

# ---------------------------------------------------------------- diagram
ANSWERS = ["Rain each hour", "When it starts", "Heaviest hour", "How long",
           "How much", "Thunder", "Flood risk", "Why it rains"]
INPUTS = [("Global forecasts", "GFS · ECMWF IFS · AIFS"),
          ("Rain falling now", "GOES satellite · MRMS radar"),
          ("Airport reports", "the last three hours"),
          ("Physics, computed", "mountain rain · sea breezes"),
          ("The place itself", "terrain · coast · sun · season")]
svg = []
for i, (t, s) in enumerate(INPUTS):
    y = 48 + i * 70
    svg.append(f'            <rect class="dg-box" x="16" y="{y}" width="220" height="58" rx="10"/>\n'
               f'            <text class="dg-title" x="34" y="{y + 25}">{t}</text>\n'
               f'            <text class="dg-sub"   x="34" y="{y + 43}">{html.escape(s)}</text>\n'
               f'            <path class="dg-edge" d="M236 {y + 29} H296" marker-end="url(#pv-ah)"/>')
STRANDS = [("Geodesic attention", "each head its own radius, 15–500 km"),
           ("Index attention", "finds places that look alike, anywhere"),
           ("Recurrence through time", "a gated delta rule along the frames")]
for i, (t, s) in enumerate(STRANDS):
    y = 112 + i * 74
    svg.append(f'            <rect class="dg-box" x="320" y="{y}" width="310" height="62" rx="10"/>\n'
               f'            <text class="dg-title" x="338" y="{y + 27}">{t}</text>\n'
               f'            <text class="dg-sub"   x="338" y="{y + 45}">{s}</text>')
for i, a in enumerate(ANSWERS):
    y = 48 + i * 43
    svg.append(f'            <rect class="dg-box" x="978" y="{y}" width="146" height="34" rx="8"/>\n'
               f'            <text class="dg-title" x="992" y="{y + 22}">{a}</text>')
STATES = ["Dry", "Light", "Mod.", "Heavy"]
chain = "\n".join(
    f'            <rect class="dg-box" x="{730 + i * 49}" y="208" width="40" height="28" rx="6"/>\n'
    f'            <text class="dg-sub" x="{750 + i * 49}" y="226" text-anchor="middle">{s}</text>'
    for i, s in enumerate(STATES))

DIAGRAM = """      <figure class="diagram mt-m" data-reveal>
        <div class="diagram-scroll">
          <svg viewBox="0 0 1140 440" width="1140" height="440" role="img"
               aria-labelledby="pv-title pv-desc">
            <title id="pv-title">How Pluvium makes a forecast: inputs, one Caribbean mesh, every town, one chain of rain states</title>
            <desc id="pv-desc">On the left, five inputs: the global models' forecasts (GFS, ECMWF IFS
              and AIFS), the rain falling now from the GOES satellite and MRMS radar, the last three
              hours of airport reports, physics computed rather than learned (mountain rain and sea
              breezes), and the place itself (terrain, coast, sun and season). They are read onto one
              Caribbean mesh of 6,075 points, about 11 kilometres apart over land and 80 at sea, with 43
              frames, and processed by twelve iHELIX blocks, the engine NatureV1 runs on. Each block
              combines geodesic attention, whose heads each have a radius from 15 to 500 kilometres,
              index attention that finds places that look alike anywhere, and a recurrence through the
              forecast's frames. Every town then reads the mesh around it with its own terrain, coast
              and climate. One chain of four rain states per town and hour, dry, light, moderate and
              heavy, gives the chance of rain each hour, when it starts, the heaviest hour and how long
              it lasts and, with the other heads, how much falls, thunder, flood risk and why it
              rains.</desc>

            <defs>
              <marker id="pv-ah" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                <path d="M0,1 L9,5 L0,9 z" class="dg-arrow"/>
              </marker>
            </defs>

            <text class="dg-tag" x="16" y="30">Inputs</text>
            <text class="dg-tag" x="300" y="30">One Caribbean mesh</text>
            <text class="dg-tag" x="714" y="30">Every town, every hour</text>
            <text class="dg-tag" x="978" y="30">Answers</text>

@@INPUTS@@

            <rect class="dg-box-a" x="300" y="48" width="350" height="338" rx="12"/>
            <text class="dg-title" x="320" y="76">A mesh of 6,075 points</text>
            <text class="dg-sub"   x="320" y="94">about 11 km apart over land, 80 km at sea · 43 frames</text>
@@STRANDS@@
            <text class="dg-title" x="320" y="352">&#215; 12 iHELIX blocks</text>
            <text class="dg-sub"   x="320" y="370">the engine NatureV1 runs on</text>
            <path class="dg-edge" d="M650 83 H710" marker-end="url(#pv-ah)"/>

            <rect class="dg-box" x="714" y="48" width="220" height="72" rx="10"/>
            <text class="dg-title" x="730" y="73">Each town reads the mesh</text>
            <text class="dg-sub"   x="730" y="91">its own terrain, coast and climate</text>
            <text class="dg-sub"   x="730" y="107">from a 35 km terrain patch</text>
            <path class="dg-edge" d="M824 120 H824 V142" marker-end="url(#pv-ah)"/>

            <rect class="dg-box-a" x="714" y="146" width="220" height="150" rx="10"/>
            <text class="dg-title" x="730" y="172">One chain of rain states</text>
            <text class="dg-sub"   x="730" y="190">a 4 &#215; 4 table of chances per hour</text>
@@CHAIN@@
            <text class="dg-sub"   x="730" y="258">now &#8594; each state an hour later</text>
            <text class="dg-sub"   x="730" y="276">sampled for windows and totals</text>
            <path class="dg-edge" d="M824 296 H824 V314" marker-end="url(#pv-ah)"/>

            <rect class="dg-box" x="714" y="318" width="220" height="68" rx="10"/>
            <text class="dg-title" x="730" y="344">Other heads</text>
            <text class="dg-sub"   x="730" y="362">amounts · thunder · kind · cause</text>

            <path class="dg-edge" d="M934 216 H974" marker-end="url(#pv-ah)"/>
            <path class="dg-edge" d="M934 352 H974" marker-end="url(#pv-ah)"/>

            <text class="dg-sub" x="16" y="424">Physics is computed, not learned: Smith&#8211;Barstad mountain rain, sea-breeze convergence, fronts, and the rain now carried along the steering wind.</text>
          </svg>
        </div>

        <div class="diagram-key">
          <span><i aria-hidden="true"></i> Information forward</span>
          <span>Encode &rarr; process &rarr; decode &rarr; chain</span>
          <span>Every answer from one chain</span>
        </div>

        <figcaption>How Pluvium makes a forecast. The global models&rsquo; fields, the rain falling now,
          airport reports and computed physics are read onto one Caribbean mesh and processed by 12 iHELIX
          blocks &mdash; the engine <a href="/models/naturev1/">NatureV1</a> runs on. Every town then reads
          the mesh around it, and one chain of rain states per town gives every hourly answer.</figcaption>
      </figure>"""
DIAGRAM = (DIAGRAM.replace("@@INPUTS@@", "\n".join(svg[:5]))
           .replace("@@STRANDS@@", "\n".join(svg[5:8]))
           .replace("@@CHAIN@@", chain))
DIAGRAM = DIAGRAM.replace("            <path class=\"dg-edge\" d=\"M650 83 H710\"",
                          "\n".join(svg[8:]) + "\n            <path class=\"dg-edge\" d=\"M650 83 H710\"")

# ---------------------------------------------------------------- body
MAIN = """<main id="main">

  <div class="shell page-head">
    <nav class="crumbs" aria-label="Breadcrumb">
      <ol>
        <li><a href="/">Home</a></li>
        <li><a href="/models/">Our Products</a></li>
        <li><span aria-current="page">Pluvium</span></li>
      </ol>
    </nav>

    <div class="tag-row" style="margin-top:22px">
      <span class="tag tag-live"><i class="dot" aria-hidden="true"></i> New</span>
      <span class="tag">Rain forecasts</span>
      <span class="tag">Every Caribbean town</span>
      <span class="tag">Hour by hour</span>
      <span class="tag">Apache-2.0</span>
      <span class="tag">Research model</span>
    </div>

    <h1>Pluvium</h1>
    <p class="lede">Open-source rain forecasts for every town and village in the Caribbean, hour by
      hour, three days ahead &mdash; made in Jamaica. For each place it answers the questions people
      actually ask: will it rain, when will it start, how long will it last, how much will fall, and
      could it flood?</p>

    <div class="btn-row mt-m">
      <a class="btn btn-primary" href="https://pypi.org/project/pluvium/" rel="noopener" target="_blank">
        View on PyPI
        @@EXT@@
      </a>
      <a class="btn btn-ghost" href="#results">See the results</a>
    </div>
    <p class="mt-s" style="font-size:.82rem;color:var(--faint)">
      Package: <code>pluvium</code> 0.1.0 &middot; Python &ge; 3.10 &middot; Engine: NatureV1 / iHELIX &middot;
      Developer: Nathan &middot; Origin: Jamaica
    </p>
  </div>

  <div class="shell"><hr class="rule"></div>

  <!-- Answer-first summary -->
  <section class="section-tight" id="what-it-is">
    <div class="shell">
      <div class="answer-box" style="margin-top:0" data-reveal>
        <p><strong>Pluvium</strong> is an AI rain-forecasting system built by
          <a href="/about/">CorX Labs</a> in Jamaica. For every town and village in the Caribbean it
          forecasts rain hour by hour for the next three days: the chance of rain each hour, whether it
          will be drizzle, showers, steady rain, heavy rain or a thunderstorm, the hour it will most
          likely start (in local time, with a window), how long it will last, and how much will fall
          &mdash; a median and a bad case. <strong>Every answer comes from one chain of rain states, so
          the answers never contradict each other.</strong></p>
        <p>It is tested against the forecasts people already use &mdash; ECMWF ENS, HRES and AIFS, and
          NOAA GEFS, GraphCast and GFS &mdash; on real archived runs, with every system calibrated the
          same way. On 450 land cells covering Jamaica in <strong>July and August 2025</strong>, Pluvium
          had the <strong>highest skill of any single system for rain of at least 1&nbsp;mm on days 1 and
          2</strong>. In
          <strong>May and June 2025 it lost</strong>, after a wet April it had never trained on. Both
          results are published.</p>
        <p><strong>Pluvium Blend</strong> combines all six operational systems, each post-processed on its
          own first so every rival gets a fair chance, into daily rain chances out to 14 days. And nothing
          in Pluvium is tied to Jamaica: any country between 60&deg;&nbsp;S and 60&deg;&nbsp;N can be set
          up with one command.</p>
      </div>

      <div class="callout mt-m" data-reveal>
        <p><strong>A research model, not an official forecast.</strong> Pluvium is new and no independent
          party has verified it. Its flood levels are a rule that has not been checked against flood
          reports, and its alerts are marked as exercises. <strong>Do not use Pluvium for real
          decisions.</strong> Follow your national meteorological service &mdash; in Jamaica, the
          Meteorological Service of Jamaica and @@ODPEM@@.</p>
      </div>

      <dl class="spec-list mt-m" data-reveal>
        <div><dt>Covers</dt><dd>Every Caribbean town and village</dd></div>
        <div><dt>Forecast</dt><dd>Hourly, 3 days</dd></div>
        <div><dt>Pluvium Blend</dt><dd>Daily, 14 days</dd></div>
        <div><dt>Engine</dt><dd>NatureV1 / iHELIX, 12 blocks</dd></div>
        <div><dt>Mesh</dt><dd>6,075 points, ~11 km over land</dd></div>
        <div><dt>Head radii</dt><dd>15&ndash;500 km</dd></div>
        <div><dt>Rain states</dt><dd>Dry, light, moderate, heavy</dd></div>
        <div><dt>Full size</dt><dd>Pluvium-500, 57.9M params</dd></div>
        <div><dt>Tested size</dt><dd>pluvium-small, 0.9M params</dd></div>
        <div><dt>Bulletins</dt><dd>English, Spanish, French, Patois</dd></div>
        <div><dt>Licence</dt><dd>Apache-2.0</dd></div>
        <div><dt>Status</dt><dd>New &mdash; research model</dd></div>
      </dl>
    </div>
  </section>

  <!-- What it tells you -->
  <section class="section-tight" id="outputs" style="padding-top:0">
    <div class="shell">
      <h2>1. What it tells you</h2>
      <div class="prose">
        <p>For each place, every hour, out to three days &mdash; in the words a person would use:
          &ldquo;light drizzle&rdquo;, &ldquo;moderate showers&rdquo;, &ldquo;heavy rain&rdquo;,
          &ldquo;thunderstorms&rdquo;, &ldquo;torrential rain&rdquo;.</p>
      </div>

      <div class="grid grid-3 mt-m" data-reveal>
        <article class="card">
          <h3>Will it rain?</h3>
          <p>The chance of rain in each hour, and of any rain or any heavy rain in the next 6, 12, 24, 48
            and 72 hours &mdash; computed exactly from the chain, not by pretending the hours are
            independent.</p>
        </article>
        <article class="card">
          <h3>What kind of rain?</h3>
          <p>Drizzle, rain or showers, and how hard: light, moderate or heavy. A separate head gives the
            chance of thunder.</p>
        </article>
        <article class="card">
          <h3>When does it start?</h3>
          <p>The hour rain will most likely start, in local time and with a window, and the hour it will
            be heaviest.</p>
        </article>
        <article class="card">
          <h3>How long, and how much?</h3>
          <p>How long it will last, and the day&rsquo;s total as a median and a bad case (the 90th
            percentile), with the chance of 10, 25, 50 and 100&nbsp;mm and the wettest three hours.</p>
        </article>
        <article class="card">
          <h3>Why is it raining?</h3>
          <p>The cause: a cold front or shear line, a tropical wave, a tropical cyclone, afternoon storms
            or trade-wind showers.</p>
        </article>
        <article class="card">
          <h3>Lightning, and could it flood?</h3>
          <p>Lightning within 10&nbsp;km in the last 15 minutes, from space. Flood risk with its reason,
            from the rain over the town&rsquo;s river catchment &mdash; a rule, not yet verified.</p>
        </article>
      </div>

      <h3 class="mt-m">What <code>pluvium forecast</code> writes</h3>
      <div class="table-wrap mt-s" data-reveal>
        <table>
          <caption class="visually-hidden">Files written by the pluvium forecast command and what each contains</caption>
          <thead>
            <tr><th scope="col">File</th><th scope="col">What is in it</th></tr>
          </thead>
          <tbody>
            <tr><th scope="row"><code>towns.csv</code></th><td>One row per place: the chance of rain now and in 6, 12, 24, 48 and 72 hours, heavy rain, thunder, the main weather, the likely start and its window (local time), the heaviest hour, 24-hour totals (median, 90th percentile, chance of 10, 25, 50 and 100&nbsp;mm), the wettest 3 hours, rain over the river catchment, flood risk and its reason, lightning now, the cause, and a one-sentence summary</td></tr>
            <tr><th scope="row"><code>parishes.csv</code></th><td>One row per parish or province, with a headline</td></tr>
            <tr><th scope="row"><code>towns.geojson</code></th><td>The same as points, for maps</td></tr>
            <tr><th scope="row"><code>hourly.npz</code></th><td>The hourly chance of rain, of each intensity and of thunder, and the expected rain, per place</td></tr>
            <tr><th scope="row"><code>forecast.json</code>, <code>report.txt</code></th><td>Metadata and a readable digest</td></tr>
          </tbody>
        </table>
      </div>
      <div class="prose mt-m">
        <p>Bulletins come in English, Spanish or French, and in Jamaican Patois for Jamaica. Alerts are
          written in CAP&nbsp;1.2, the common alerting format, and carry the status &ldquo;Exercise&rdquo;
          rather than &ldquo;Actual&rdquo;.</p>
      </div>
    </div>
  </section>

  <!-- How it works -->
  <section class="section-tight" id="engine">
    <div class="shell">
      <h2>2. How it works</h2>
      <div class="prose">
        <p>The global models are good at the large-scale weather but blur island rain. Their grids are
          9&ndash;25&nbsp;km or coarser, convection is parameterised, and the daily cycle of showers is often
          at the wrong hour: GraphCast, for one, puts tropical rain too close to local midday. Radar
          nowcasting needs radar, and the Caribbean has almost no open radar. Pluvium is built for what
          the region does have: the global models&rsquo; coarse forecasts, satellite rain, hourly airport
          reports and lightning seen from space.</p>
      </div>

@@DIAGRAM@@

      <h3 class="mt-m" id="chain">One chain, every answer</h3>
      <div class="prose">
        <p>Most AI rain models write a separate number for every hour. Pluvium&rsquo;s network writes, for
          every hour and town, a 4&nbsp;&times;&nbsp;4 table of chances: from dry, light, moderate or heavy
          rain now to each of them an hour later. One chain then gives every answer consistently &mdash;
          the chance of rain each hour, the hour rain most likely starts, the hour it turns heavy, when it
          stops, the chance of any rain in the next 6 to 72 hours, and totals and the wettest 1, 3 and 6
          hours, by sampling paths of the chain.</p>
      </div>

      <h3 class="mt-m" id="instruments">Trained through the instruments&rsquo; eyes</h3>
      <div class="prose">
        <p>Neither source of truth is perfect. A satellite smears a downpour over an 8&nbsp;km box and
          misses light showers; an airport sees one spot. So training scores what each instrument
          reported through its own learned confusion matrix &mdash; a differentiable hidden Markov model
          &mdash; and a satellite miss is never taught to the model as &ldquo;it was dry&rdquo;.</p>
      </div>

      <h3 class="mt-m" id="physics">Physics given, not learned</h3>
      <div class="grid grid-3 mt-s" data-reveal>
        <article class="card">
          <h3>Mountain rain</h3>
          <p>Smith&ndash;Barstad linear theory, solved on 2&nbsp;km tiles for every forecast hour with
            learned time scales: rain on the windward slopes, a shadow in the lee.</p>
        </article>
        <article class="card">
          <h3>Sea-breeze storms</h3>
          <p>Where the sea breezes meet over each island in the afternoon, and when the sea-breeze front
            passes, from gravity-current theory.</p>
        </article>
        <article class="card">
          <h3>Saharan air</h3>
          <p>An index for the Saharan air layer: the dry, warm mid-levels that choke summer
            showers.</p>
        </article>
        <article class="card">
          <h3>Waves and fronts</h3>
          <p>Tropical-wave troughs at 700&nbsp;hPa, cold fronts and shear lines, with their arrival times
            at every place.</p>
        </article>
        <article class="card">
          <h3>Storm rain</h3>
          <p>Cyclones are too rare in any training period to learn from, so a storm-rain prior with shear
            asymmetry is an input.</p>
        </article>
        <article class="card">
          <h3>The daily clock</h3>
          <p>Instability (CAPE and CIN), column humidity and the land and sea daily cycles, aimed at the
            hour of afternoon storms, which global AI models often get wrong.</p>
        </article>
      </div>
      <div class="prose mt-m">
        <p>For the first 12 hours the rain already falling is carried along the steering wind &mdash;
          the core idea of radar nowcasting, done with satellite rain because the region has so little
          open radar.</p>
      </div>
    </div>
  </section>

  <!-- Pluvium Blend -->
  <section class="section-tight" id="blend">
    <div class="shell">
      <h2>3. Pluvium Blend: every operational system in one forecast</h2>
      <div class="prose">
        <p>Pluvium&rsquo;s network reads one driving model at a time. <strong>Pluvium Blend</strong>
          reads all six operational systems at once &mdash; ECMWF ENS, NOAA GEFS, ECMWF HRES, ECMWF AIFS,
          NOAA GraphCast and NOAA GFS &mdash; and, where it runs, Pluvium&rsquo;s own network. It writes one
          calibrated forecast of each day&rsquo;s rain for every place, <strong>out to 14 days</strong>.</p>
      </div>

      <ol class="steps mt-m" data-reveal>
        <li><div><h3>Post-process every system on its own</h3><p>A small network turns one
          system&rsquo;s forecast into the chance of at least 0.2, 0.5, 1, 2&nbsp;&hellip; up to 150&nbsp;mm.
          The chances fall with the threshold by construction, so they never contradict each other. One
          copy is trained per system, which gives that system&rsquo;s own post-processed forecast. Another
          copy reads every system at once.</p></div></li>
        <li><div><h3>Pool them with about 70 weights</h3><p>The pool averages the components&rsquo;
          log-odds with one weight per component, per band of thresholds and per lead. Its weights are
          fitted on alternate weeks the components never trained on, so no component is judged on truth it
          learned from. A pool this small cannot overfit, and it can always fall back to its best
          component. A missing system &mdash; GraphCast stops at day 10 &mdash; simply drops out.</p></div></li>
        <li><div><h3>Beat every rival after equal treatment</h3><p>Each system&rsquo;s component is that
          system&rsquo;s post-processed forecast, scored on its own. Pluvium Blend has to beat each of them,
          not just their raw output.</p></div></li>
      </ol>

      <div class="prose mt-m">
        <p>Why two layers: inside the training year, one network over all six systems was no better than
          the best single system &mdash; it learned combinations that did not carry over to a new season.
          The pool beat that network in about 20 of 24 comparisons. Training a blend for a new country
          takes a year of archived runs and satellite truth: about two hours of downloads and under an hour
          of CPU.</p>
      </div>
    </div>
  </section>

  <!-- Results -->
  <section class="section-tight" id="results">
    <div class="shell">
      <h2>4. Results</h2>

      <div class="callout" data-reveal>
        <p><strong>Every number here was measured on real, archived forecasts &mdash; no reanalysis
          anywhere.</strong> Truth is CMORPH satellite rain, adjusted to rain gauges, at 450 land cells of
          8&nbsp;km covering Jamaica. Every system, Pluvium included, is calibrated the same causal way, on
          the 30 runs before each test day. The model tested is <strong>pluvium-small</strong> (0.9M
          parameters, about two hours of training on a 4-core CPU), driven only by GFS.</p>
      </div>

      @@SCORECARD@@

      <h3 class="mt-m" id="jul-aug-2025">July and August 2025 &mdash; protocol frozen before the data were downloaded</h3>
      <div class="prose">
        <p>The scorecard above in words &mdash; 62 daily 00&nbsp;UTC runs, every system calibrated with the
          same logistic regression on its 30 previous runs:</p>
      </div>
      <div class="prose mt-m">
        <ul>
          <li><strong>Rain at all (at least 1&nbsp;mm):</strong> the highest skill of any single system on
            days 1 and 2. With 95% confidence it beats ECMWF ENS and HRES on all three days, AIFS and
            GraphCast on days 1 and 2, and the blend of all six on day 1. Against GEFS and GFS it is ahead on
            days 1 and 2 in 86&ndash;97% of bootstrap resamples, but the 95% interval still includes no
            difference. On day 3 it ties everything except ENS and HRES.</li>
          <li><strong>10&nbsp;mm or more:</strong> a tie with the best system on every day.</li>
          <li><strong>25 and 50&nbsp;mm:</strong> no system, ECMWF&rsquo;s included, does meaningfully
            better than a forecast that never says rain. Rain this heavy at one 8&nbsp;km cell on one day
            is too rare (0.5% and 0.1% of cell-days) for any of them.</li>
          <li><strong>Daily totals:</strong> Pluvium&rsquo;s
            <abbr title="continuous ranked probability score">CRPS</abbr> is 40&ndash;50% smaller than
            ECMWF ENS&rsquo;s and GEFS&rsquo;s on every day &mdash; 0.87&nbsp;mm against 1.45 and 1.80 on
            day 1. This compares raw outputs, and only Pluvium was trained on CMORPH, so part of the gap is
            calibration.</li>
          <li><strong>It adds information:</strong> adding Pluvium to the blend of all six raises skill at
            1&nbsp;mm from +0.090 to +0.136 on day 1 and from +0.095 to +0.134 on day 2.</li>
        </ul>
      </div>

      <h3 class="mt-m" id="may-jun-2025">May and June 2025 &mdash; the test Pluvium lost</h3>
      <div class="prose">
        <p>The first test, also with its protocol fixed in advance. After calibration Pluvium was worse
          than the best operational system on 9 of 12 threshold-day comparisons (95% confidence) and tied
          on the other 3. Its raw forecasts still discriminated best &mdash; ROC area 0.76 at 1&nbsp;mm and
          0.84 at 10&nbsp;mm on day 1 &mdash; and had the best CRPS, 0.94&nbsp;mm against 1.82 for ECMWF
          ENS.</p>
        <p><strong>Why it lost.</strong> Every system is calibrated on the 30 runs before each test day,
          so early-May forecasts were calibrated on April. April 2025 was unusually wet on Jamaica
          (2.6&nbsp;mm per cell and day, against May&rsquo;s 0.8), and Pluvium had never trained on an
          April. The calibration learned that any rain Pluvium forecast meant a heavy event, and on the
          first days of May turned modest forecasts into 96&ndash;98% chances of 25&nbsp;mm, on days when at
          most 6% of cells saw that much. The protocol then moved from isotonic to logistic calibration,
          frozen in a commit before July and August were downloaded. Both protocols, for both periods:</p>
      </div>
      <div class="table-wrap mt-s" data-reveal>
        <table>
          <caption class="visually-hidden">Brier skill score for at least 1 mm on Jamaica, days 1, 2 and 3, for both test periods under both calibration protocols</caption>
          <thead>
            <tr><th scope="col">Test period</th><th scope="col">Calibration</th><th scope="col">Pluvium, days 1 / 2 / 3</th><th scope="col">Best operational system, days 1 / 2 / 3</th></tr>
          </thead>
          <tbody>
            <tr><th scope="row">May&ndash;June 2025</th><td>isotonic</td><td>&minus;0.032 / &minus;0.034 / +0.021</td><td>+0.082 / +0.083 / +0.066</td></tr>
            <tr><th scope="row">May&ndash;June 2025</th><td>logistic</td><td>+0.051 / +0.026 / &minus;0.048</td><td>+0.097 / +0.107 / +0.072</td></tr>
            <tr><th scope="row">July&ndash;August 2025</th><td>isotonic</td><td>+0.126 / +0.118 / +0.014</td><td>+0.083 / +0.084 / +0.067</td></tr>
            <tr><th scope="row">July&ndash;August 2025</th><td>logistic (frozen)</td><td>+0.127 / +0.118 / +0.052</td><td>+0.087 / +0.091 / +0.063</td></tr>
          </tbody>
        </table>
      </div>
      <div class="prose mt-s">
        <p>The July&ndash;August calibration windows contain no April. That is luck of the calendar, not a
          fix &mdash; which is why training on every month is first on the list below.</p>
      </div>
      <div class="mt-m">@@MAYJUN@@</div>

      <h3 class="mt-m" id="versions">Between versions</h3>
      <div class="prose">
        <p>Each version of pluvium-small was trained from scratch on the same Jamaican data with the same
          32-minute budget on a 4-core CPU, then scored on held-out autumn 2021 with emulated forecast
          errors. Skill is against climatology unless stated.</p>
      </div>
      <div class="table-wrap mt-s" data-reveal>
        <table>
          <caption class="visually-hidden">Pluvium versions 1, 2 and 3 compared on the same data and budget, with emulated forecast errors</caption>
          <thead>
            <tr><th scope="col">Score</th><th scope="col">Version 1</th><th scope="col">Version 2</th><th scope="col">Version 3</th></tr>
          </thead>
          <tbody>
            <tr><th scope="row">Hourly rain chance, skill</th><td>+13.1%</td><td>+16.0%</td><td><strong>+16.4%</strong></td></tr>
            <tr><th scope="row">Yes/no at 30%: critical success index</th><td>0.157</td><td>0.200</td><td><strong>0.214</strong></td></tr>
            <tr><th scope="row">Any rain in 24 h, skill</th><td>+48.4%</td><td>+49.3%</td><td><strong>+50.5%</strong></td></tr>
            <tr><th scope="row">Rain start within 2 h of the truth</th><td>0.454</td><td><strong>0.464</strong></td><td>0.463</td></tr>
            <tr><th scope="row">24 h totals, CRPS skill</th><td>+15.2%</td><td>+23.8%</td><td><strong>+44.6%</strong></td></tr>
            <tr><th scope="row">Heavy hours, skill</th><td><strong>+0.6%</strong></td><td>&minus;3.2%</td><td>&minus;4.5%</td></tr>
            <tr><th scope="row">Thunder at airports, skill</th><td>n/a</td><td><strong>+2.6%</strong></td><td>+0.6%</td></tr>
          </tbody>
        </table>
      </div>
      <div class="prose mt-s">
        <p>Version 3, the default, nearly doubles the skill of 24-hour totals and has the best hourly skill
          &mdash; with 392 training steps against version 2&rsquo;s 592, because its deeper engine costs more
          per step. Heavy-rain hours and thunder remain its weak spots.</p>
      </div>

      <h3 class="mt-m" id="six-regions">Six regions, a full year &mdash; being scored now</h3>
      <div class="prose">
        <p>A larger test is running: six regions on a 0.25&deg; grid &mdash; the Caribbean, the Maritime
          Continent, the Alps, the US Pacific Northwest, the US Great Plains, and southern Chile and the
          Andes &mdash; trained on April 2024 to March 2025 and scored on forecasts from April 2025 to March
          2026, out to 14 days, against all six operational systems, each post-processed by the same
          network. In these regions Pluvium Blend pools the operational systems; Pluvium&rsquo;s own network
          runs only at 8&nbsp;km in the countries it was trained for.</p>
        <p><strong>Early results from four of the six regions, not yet published with the code:</strong>
          for rain of at least 1&nbsp;mm, Pluvium Blend beat every system&rsquo;s post-processed forecast on
          days 1 to 7 in all four, with 95% confidence, and on days 8 to 10 in three of the four (in the
          Pacific Northwest it did not beat ENS or AIFS). The margins are small: in the Caribbean on days 1
          to 3, a Brier skill of +0.228 against +0.218 for post-processed AIFS, which was better there at
          50&nbsp;mm on days 1 to 7 and on root-mean-square error on days 1 to 3. The Great Plains and the
          southern Andes are still being scored.</p>
      </div>

      <h3 class="mt-m" id="next">What is still missing</h3>
      <div class="prose">
        <ol>
          <li><strong>Train on every month, over several years.</strong> Stage B never saw an April, and the
            climatology input came from one year. A retrain on all twelve months with a multi-year
            climatology is under way.</li>
          <li><strong>Give Pluvium the ensembles.</strong> GEFS and ENS earn their day-3 skill from their
            spread; ensemble statistics could become inputs.</li>
          <li><strong>Train the real model.</strong> The tests used pluvium-small, 0.9M parameters trained
            for about two hours on a CPU. Pluvium-500 is 60 times larger and is designed for a day on one
            RTX PRO 6000.</li>
          <li><strong>Calibrate on the same weeks of earlier years.</strong> Season-matched windows, as
            reforecast-based calibration does, instead of the trailing 30 days that a dry-to-wet change
            breaks.</li>
        </ol>
      </div>
    </div>
  </section>

  <!-- Any country -->
  <section class="section-tight" id="any-country">
    <div class="shell">
      <h2>5. Use it in your country</h2>
      <div class="prose">
        <p>Nothing in Pluvium is tied to Jamaica. The engine works on the sphere, and every source it
          learns from is global: terrain, borders, towns, satellite rain, airports and the driving models.
          Any country between 60&deg;&nbsp;S and 60&deg;&nbsp;N can be set up in minutes &mdash; here,
          Trinidad and Tobago:</p>
      </div>
      <pre class="mt-s"><code>pluvium setup --country TT --root ~/pluvium-TT     # area, terrain, provinces and every town
pluvium blend train --root ~/pluvium-TT            # learn Pluvium Blend from a year of archived runs (CPU, ~2 h)
pluvium blend forecast --root ~/pluvium-TT         # 14 days of daily rain chances for every town
pluvium program --root ~/pluvium-TT --country TT   # train Pluvium's own network for the country (GPU)</code></pre>
      <div class="prose mt-m">
        <ul>
          <li><code>--country</code> takes ISO codes, one or several (<code>DO,HT</code> for Hispaniola).
            <code>--box south,north,west,east</code> sets the extent by hand; split large countries into
            regions.</li>
          <li>Bulletins come in each country&rsquo;s languages: English, Spanish or French, and Jamaican
            Patois for Jamaica.</li>
          <li>Live &ldquo;rain now&rdquo; comes from GOES-East or GOES-West wherever they see, across the
            Americas and the Pacific. Elsewhere Pluvium forecasts without it, as a third of its training
            forecasts did.</li>
          <li>Set up and tested from live data in <strong>Jamaica, Trinidad and Tobago, Sri Lanka</strong>
            (in the eastern hemisphere) and <strong>Ghana</strong> (which straddles longitude 0). An area
            that crosses the date line is refused with a clear message.</li>
        </ul>
      </div>
    </div>
  </section>

  <!-- Install and run -->
  <section class="section-tight" id="usage">
    <div class="shell">
      <h2>6. Install and run</h2>
      <pre><code>pip install pluvium</code></pre>
      <div class="prose mt-m">
        <p>With a trained model:</p>
      </div>
      <pre class="mt-s"><code>pluvium forecast --country JM              # every place; tables in ./pluvium-forecast, a report on screen
pluvium place "Port Antonio" --country JM  # hour by hour for one place
pluvium learn                              # check past forecasts against airport reports; update the corrections
pluvium info                               # what the published model is and how it scored</code></pre>

      <div class="callout mt-m" data-reveal>
        <p><strong>The weights of Pluvium-500, the full-size model, are not published yet.</strong> The
          results on this page come from pluvium-small. To train your own, <code>pluvium program</code> runs
          the whole pipeline on one GPU &mdash; geography and towns, ERA5, CMORPH and airport reports,
          climatology, two training stages, calibration and scoring on a held-out year, publishing to the
          Hugging Face Hub, and the live forecast &mdash; and resumes where it stopped.</p>
      </div>
      <pre class="mt-s"><code>GPU_HOURS=24 HF_TOKEN=... HF_REPO=you/Pluvium-500 pluvium program</code></pre>
      <div class="prose mt-m">
        <p>From Python, with a model you have published:</p>
      </div>
      <pre class="mt-s"><code>from pluvium.cli import fetch_model
from pluvium.forecast import Forecaster, place_timeline

fc = Forecaster(fetch_model("you/Pluvium-500"))
result = fc.run(out_dir="forecast")
print(place_timeline(fc.towns, result["summary"], "Mandeville", country="JM", hours=24))</code></pre>

      <h3 class="mt-m">Live data</h3>
      <div class="table-wrap mt-s" data-reveal>
        <table>
          <caption class="visually-hidden">The live data feeds Pluvium reads and what each is used for</caption>
          <thead>
            <tr><th scope="col">Feed</th><th scope="col">Used for</th></tr>
          </thead>
          <tbody>
            <tr><th scope="row">GFS (NOAA), ECMWF IFS and AIFS open data</th><td>The driving fields: one forecast per model, mixed, so their disagreement widens the windows</td></tr>
            <tr><th scope="row">GEFS, 31 members (optional)</th><td>More members in the mix, so the spread of start times and totals reflects the atmosphere&rsquo;s own uncertainty</td></tr>
            <tr><th scope="row">GOES-East rain rate</th><td>The rain falling now, and the field carried along the wind; infrared when the rain-rate product is unavailable</td></tr>
            <tr><th scope="row">MRMS Caribbean radar (NOAA)</th><td>Rain now where radar reaches: Puerto Rico and the Virgin Islands</td></tr>
            <tr><th scope="row">METAR airport reports</th><td>The last three hours of weather, and the truth that online learning checks forecasts against</td></tr>
            <tr><th scope="row">GOES-East Geostationary Lightning Mapper</th><td>Lightning within 10&nbsp;km of each town in the last 15 minutes</td></tr>
          </tbody>
        </table>
      </div>

      <h3 class="mt-m">Learning from its mistakes</h3>
      <div class="prose">
        <p><code>pluvium learn</code> reads what the airports reported after each forecast and updates a
          corrector for every parish, lead time and part of the day. The corrector is pulled back towards
          &ldquo;no correction&rdquo; at every step, so it moves only on repeated evidence and relaxes when a
          pattern ends. A parish without an airport borrows its country&rsquo;s correction.</p>
        <p><strong>Licence and data.</strong> The code is Apache-2.0. The data has its own terms: ERA5
          (Copernicus Climate Change Service); CMORPH CDR and ISD (NOAA NCEI); GFS and GEFS (NOAA NCEP);
          NOAA&rsquo;s real-time GraphCast; ECMWF open data, IFS, ENS and AIFS (CC-BY-4.0); GOES-East imagery
          and lightning (NOAA); METAR (NOAA Aviation Weather Center); GeoNames and geoBoundaries
          (CC-BY-4.0); and Terrarium elevation tiles (Mapzen and its sources).</p>
      </div>
    </div>
  </section>

  <!-- Failure modes -->
  <section class="section-tight" id="failure-modes">
    <div class="shell">
      <h2>7. When something goes wrong</h2>
      <div class="prose">
        <p>A forecast system fails in operation in ways no benchmark shows. Pluvium checks for the failures
          that matter and says what it did about each in the forecast&rsquo;s notes.</p>
      </div>
      <div class="table-wrap mt-s" data-reveal>
        <table>
          <caption class="visually-hidden">Failures Pluvium checks for in operation and what it does about each</caption>
          <thead>
            <tr><th scope="col">Failure</th><th scope="col">What Pluvium does</th></tr>
          </thead>
          <tbody>
            <tr><th scope="row">A driving model changes units (Celsius for Kelvin, hPa for Pa)</th><td>Caught from physical ranges, converted, and noted</td></tr>
            <tr><th scope="row">Missing fields, gaps or spikes, a frozen feed</th><td>Physical defaults, interpolation in time, or a flag in the notes</td></tr>
            <tr><th scope="row">The satellite rain product is paused</th><td>Falls back to the infrared estimate and names the product used</td></tr>
            <tr><th scope="row">No airport reports at all</th><td>Carries on: it was trained with whole networks of reports dropped at random</td></tr>
            <tr><th scope="row">A situation unlike training &mdash; a record hurricane, a new driving-model version</th><td>Pulled towards climatology in proportion, with the inputs responsible named</td></tr>
            <tr><th scope="row">An operational run is late or missing</th><td>The previous run at the matching lead; a system missing altogether drops out of Pluvium Blend&rsquo;s pool</td></tr>
            <tr><th scope="row">The network cannot run</th><td>A statistical fallback forecast, labelled as such</td></tr>
            <tr><th scope="row">Chances that contradict each other</th><td>Repaired before publishing, and the repairs counted</td></tr>
            <tr><th scope="row">A half-written forecast</th><td>A new forecast becomes the latest only when it is complete</td></tr>
          </tbody>
        </table>
      </div>
    </div>
  </section>

  <!-- Limits -->
  <section class="section-tight" id="limits">
    <div class="shell">
      <h2>8. Limits, stated plainly</h2>
      <div class="callout" data-reveal>
        <p><strong>Do not use Pluvium for real decisions.</strong> It is a research model, not an official
          forecast, and no independent party has verified it.</p>
      </div>
      <div class="prose mt-m">
        <ul>
          <li><strong>Tested on one island, two months at a time.</strong> Skill elsewhere and in other
            seasons is untested until the six-region year is published.</li>
          <li><strong>It lost one of its two tests.</strong> A wet April it had never trained on broke its
            calibration in May and June 2025.</li>
          <li><strong>The truth is imperfect.</strong> Satellite rain at 8&nbsp;km and airport reports;
            neither sees every shower, and the satellite under-reports mountain rain. Pluvium trained on the
            same satellite truth it is scored against, which flatters its raw scores; calibration puts every
            system on the same footing.</li>
          <li><strong>A small model.</strong> Every result comes from pluvium-small, trained for about two
            hours on a CPU. The weights of Pluvium-500 are not yet published.</li>
          <li><strong>Heavy rain is the weak spot.</strong> At 25 and 50&nbsp;mm no system beats a forecast
            that never says rain, and heavy-rain hours are below climatology in the version tests.</li>
          <li><strong>Flood risk is a rule.</strong> Its thresholds have not been verified against flood
            reports, and its alerts carry the status &ldquo;Exercise&rdquo;.</li>
          <li><strong>Live &ldquo;rain now&rdquo; is cruder than training.</strong> Outside radar it comes
            from GOES infrared when the rain-rate product is unavailable, which is cruder than the CMORPH
            used in training.</li>
          <li><strong>Tropical cyclones are rare</strong> in any training period; a storm-rain prior stands
            in for experience.</li>
          <li><strong>The driving models&rsquo; own biases</strong> in a new season are corrected only as fast
            as airport reports reveal them.</li>
        </ul>
      </div>
    </div>
  </section>

  <!-- Jamaica -->
  <section class="section-tight" id="jamaica">
    <div class="shell">
      <h2>9. Made in Jamaica, for island rain</h2>
      <div class="prose">
        <p>Pluvium is built in Jamaica, for islands where a shower can soak one side of a mountain and leave
          the other dry, and where a global model&rsquo;s grid square can be wider than a parish. It starts
          from Jamaica &mdash; its bulletins even come in Patois &mdash; covers every town and village in the
          Caribbean, and can be set up for any country that wants it.</p>
        <p>It is the second weather model from CorX Labs. <a href="/models/naturev1/">NatureV1</a> forecasts
          the whole atmosphere and hurricanes; Pluvium uses the same iHELIX engine at the scale of a town,
          for the rain people plan their day around. The engine grew out of
          <a href="/models/helix/">HELIX</a>, the lab&rsquo;s linear-context architecture.</p>
      </div>
      <div class="callout mt-m" data-reveal>
        <p><strong>For warnings in Jamaica</strong>, follow the Meteorological Service of Jamaica and the
          Office of Disaster Preparedness and Emergency Management (@@ODPEM@@). Elsewhere, follow your
          national meteorological service. Pluvium is not a substitute for any of them.</p>
      </div>
    </div>
  </section>

  <!-- FAQ -->
  <section class="section-tight" id="faq">
    <div class="shell">
      <h2>10. Questions</h2>
      <div class="faq mt-m">
@@FAQ@@
      </div>
    </div>
  </section>

  <section class="section-tight">
    <div class="shell">
      <div class="cta-band" data-reveal>
        <p class="eyebrow is-plain" style="justify-content:center">New</p>
        <h2 class="mt-s">Open code, published results &mdash; including the test it lost.</h2>
        <p>Pluvium is on PyPI under Apache-2.0, and every result on this page is reported in full &mdash;
          both operational tests, the protocol change between them and the comparison of versions.</p>
        <div class="btn-row">
          <a class="btn btn-primary" href="https://pypi.org/project/pluvium/" rel="noopener" target="_blank">
            View on PyPI
            @@EXT@@
          </a>
          <a class="btn btn-ghost" href="/models/">Back to all products</a>
        </div>
      </div>
    </div>
  </section>

  @@ALSO@@
</main>

"""

page = (HEAD.replace("@@LD@@", ld)
        + masthead + "\n\n"
        + MAIN.replace("@@DIAGRAM@@", DIAGRAM).replace("@@SCORECARD@@", sc.scorecard()).replace("@@MAYJUN@@", sc.mayjun_chart()).replace("@@FAQ@@", faq_html)
              .replace("@@EXT@@", EXT).replace("@@ODPEM@@", ODPEM).replace("@@ALSO@@", also)
        + footer + "\n\n"
        + '<script src="/assets/js/main.js" defer></script>\n</body>\n</html>\n')
assert "@@" not in page, re.findall(r"@@\w+@@", page)

# meta description length (search engines show ~155-160 characters)
desc = re.search(r'<meta name="description" content="([^"]+)"', page).group(1)
assert len(desc) <= 160, len(desc)

OUT.parent.mkdir(parents=True, exist_ok=True)
OUT.write_text(page, encoding="utf-8")
print("wrote", OUT, len(page.splitlines()), "lines; description", len(desc), "chars")
