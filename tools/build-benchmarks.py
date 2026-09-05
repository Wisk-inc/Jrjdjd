#!/usr/bin/env python3
"""
Generate the /benchmarks/ section.

Every page is written to disk as complete HTML. Nothing is client-rendered,
because robots.txt disallows query strings and a crawler that does not run
JavaScript still has to see the whole catalogue — which is the entire point of
building this as static pages rather than one app behind a ?model= parameter.

    python3 tools/build-benchmarks.py

Rerun after editing tools/model_catalog.py. Output:

    /benchmarks/                         hub + leaderboard
    /benchmarks/models/<slug>/           one per model
    /benchmarks/compare/<a>-vs-<b>/      curated head-to-heads
    /benchmarks/compare/                 interactive N-way comparison
    /benchmarks/tests/<key>/             one per benchmark
    /benchmarks/companies/<id>/          one per lab
    /assets/data/models.json             the catalogue, for the compare tool
"""

import json
import os
import shutil
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

from bm_common import (  # noqa: E402
    BENCHMARKS, BENCH_BY_KEY, BY_SLUG, COMPANIES, ICON_ARROW, ICON_EXTERNAL,
    ICON_INFO, ICON_SEARCH, PROVENANCE, ROOT, SITE, bench_cell, blended_cost,
    CATEGORY_BLURB, CATEGORY_ORDER, FIELD_PRIMARY, MIN_FIELDS, category_profile,
    category_rows,
    company_url, compare_url, crumb_ld, crumbs, esc, fmt_category,
    fmt_price, fmt_score,
    fmt_tokens, logo_img, logo_tile, model_url, modality_label, page,
    overall_standings, score_pct, scorecard, test_url,
)
from model_catalog import COMPARISONS, MODELS, validate  # noqa: E402

OUT = os.path.join(ROOT, "benchmarks")
UPDATED = "2026-09-04"


# ===========================================================================
# Small helpers
# ===========================================================================
def write(rel_path, html_text):
    path = os.path.join(ROOT, rel_path.strip("/"), "index.html")
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        f.write(html_text)
    return path


def nil(text):
    return '<span class="bm-nil">Not reported</span>' if text is None else esc(text)


def licence_of(m):
    lic = m.get("lic") or "Not stated"
    return lic


def is_open(m):
    return bool(m.get("open"))


def price_cell(m):
    pin = m.get("pin")
    if pin is None:
        return '<span class="bm-nil">—</span>'
    return esc(fmt_price(pin))


def params_label(m):
    p = m.get("params")
    if not p:
        return None
    if m.get("active"):
        return "%s total / %s active" % (p, m["active"])
    return p


def arch_label(m):
    if m.get("arch"):
        return m["arch"]
    return "Dense transformer" if m.get("params") else None


def tag_row(m):
    tags = []
    if m.get("provisional"):
        tags.append('<span class="tag">Specs pending</span>')
    tags.append('<span class="tag%s">%s</span>' % (
        " tag-live" if is_open(m) else "", "Open weights" if is_open(m) else "Proprietary"))
    if m.get("reason"):
        tags.append('<span class="tag">Reasoning</span>')
    if "image" in (m.get("inp") or []):
        tags.append('<span class="tag">Vision</span>')
    if m.get("tools"):
        tags.append('<span class="tag">Tool calling</span>')
    if m.get("arch", "").startswith("MoE"):
        tags.append('<span class="tag">Mixture of experts</span>')
    if m.get("ctx"):
        tags.append('<span class="tag">%s context</span>' % fmt_tokens(m["ctx"]))
    return '<div class="tag-row">%s</div>' % "".join(tags)


def head_to_heads_for(slug):
    out = []
    for a, b in COMPARISONS:
        if a == slug:
            out.append((b, compare_url(a, b)))
        elif b == slug:
            out.append((a, compare_url(a, b)))
    return out


def one_liner(m):
    """A short, factual phrase for cards and meta descriptions."""
    co = COMPANIES[m["company"]]["name"]
    bits = []
    if m.get("params"):
        bits.append(m["params"] + " parameters")
    if m.get("ctx"):
        bits.append(fmt_tokens(m["ctx"]) + " context")
    bits.append("open weights" if is_open(m) else "proprietary")
    return "%s from %s — %s." % (m["name"], co, ", ".join(bits))


# ===========================================================================
# Leaderboard table
# ===========================================================================
SORTABLE_BENCH = ("mmlu_pro", "gpqa", "aime", "swe", "arena")

LEADER_COLS = [
    ("name",     "Model",       "text"),
    ("company",  "Maker",       "text"),
    ("ctx",      "Context",     "num"),
    ("pin",      "In / M",      "num"),
    ("pout",     "Out / M",     "num"),
    ("mmlu_pro", "MMLU-Pro",    "num"),
    ("gpqa",     "GPQA",        "num"),
    ("aime",     "AIME",        "num"),
    ("swe",      "SWE-bench",   "num"),
    ("lic",      "Licence",     "text"),
]


def leaderboard_rows(models, checkbox=True):
    rows = []
    for m in models:
        co = COMPANIES[m["company"]]
        data = {
            "slug": m["slug"],
            "name": m["name"].lower(),
            "company": m["company"],
            "company-name": co["name"].lower(),
            "open": "1" if is_open(m) else "0",
            "reason": "1" if m.get("reason") else "0",
            "vision": "1" if "image" in (m.get("inp") or []) else "0",
            "ctx": m.get("ctx") or "",
            "pin": "" if m.get("pin") is None else m["pin"],
            "pout": "" if m.get("pout") is None else m["pout"],
            "lic": licence_of(m).lower(),
            "rel": m.get("rel") or "",
        }
        # Only the keys something can actually sort by — a data-* attribute per
        # benchmark per row costs more than it earns on a 153-row table.
        for key in SORTABLE_BENCH:
            data[key] = m.get("b", {}).get(key, "")
        attrs = " ".join('data-%s="%s"' % (k, esc(v)) for k, v in data.items())

        pick = ('<td class="bm-pick"><input type="checkbox" class="bm-pick-input" '
                'value="%s" aria-label="Add %s to comparison"></td>'
                % (esc(m["slug"]), esc(m["name"]))) if checkbox else ""

        cells = [
            '<td><span class="bm-model-cell">%s<span class="names">'
            '<a class="name" href="%s">%s</a>'
            '<span class="maker">%s%s</span></span></span></td>'
            % (logo_tile(m["company"], co["name"], 19, "is-sm"), model_url(m["slug"]),
               esc(m["name"]), esc(co["name"]),
               ('<span class="bm-kind">%s</span>' % esc(m["kind"]))
               if m.get("kind") else ""),
            '<td><a href="%s">%s</a></td>' % (company_url(m["company"]), esc(co["name"])),
            '<td class="bm-num"%s>%s</td>' % (
                (' title="%s tokens"' % format(m["ctx"], ",")) if m.get("ctx") else "",
                esc(fmt_tokens(m.get("ctx"))) if m.get("ctx") else '<span class="bm-nil">—</span>'),
            '<td class="bm-num">%s</td>' % price_cell(m),
            '<td class="bm-num">%s</td>' % (
                esc(fmt_price(m["pout"])) if m.get("pout") is not None
                else '<span class="bm-nil">—</span>'),
        ]
        for key in ("mmlu_pro", "gpqa", "aime", "swe"):
            v = m.get("b", {}).get(key)
            cells.append('<td class="bm-num">%s</td>' % (
                esc(fmt_score(key, v)) if v is not None else '<span class="bm-nil">—</span>'))
        cells.append('<td><span class="bm-badge%s">%s</span></td>' % (
            " is-open" if is_open(m) else "", esc(licence_of(m))))

        rows.append("<tr %s>%s%s</tr>" % (attrs, pick, "".join(cells)))
    return "\n".join(rows)


def leaderboard_table(models, checkbox=True, table_id="bm-leaderboard"):
    heads = ['<th class="bm-pick"><span class="visually-hidden">Compare</span></th>'] if checkbox else []
    for key, label, kind in LEADER_COLS:
        cls = ' class="bm-num"' if kind == "num" else ""
        heads.append(
            '<th%s aria-sort="none" data-sort="%s" data-kind="%s" scope="col">'
            '<button type="button"><span class="lbl">%s</span></button></th>'
            % (cls, key, kind, esc(label)))
    return """<div class="bm-table-wrap">
  <table class="bm-table" id="%s">
    <caption class="visually-hidden">AI models with context window, price per million tokens and published benchmark scores. Sortable by any column.</caption>
    <thead><tr>%s</tr></thead>
    <tbody>
%s
    </tbody>
  </table>
</div>""" % (table_id, "".join(heads), leaderboard_rows(models, checkbox))


# ===========================================================================
# Hub
# ===========================================================================
def build_hub():
    models = sorted(MODELS, key=lambda m: (-(m.get("b", {}).get("gpqa") or 0),
                                           -(m.get("b", {}).get("mmlu_pro") or 0),
                                           m["name"]))
    companies_sorted = sorted(COMPANIES.items(), key=lambda kv: kv[1]["name"].lower())
    n_models, n_companies = len(MODELS), len(COMPANIES)

    company_options = "".join(
        '<option value="%s">%s</option>' % (cid, esc(meta["name"]))
        for cid, meta in companies_sorted)

    test_cards = "".join(
        '<a class="card is-interactive" href="%s"><h3 style="font-family:var(--sans);'
        'font-size:1.02rem;font-weight:600;letter-spacing:-.01em">%s</h3>'
        '<p style="margin-top:8px">%s</p>'
        '<span class="arrow-link" style="margin-top:14px">Read the test %s</span></a>'
        % (test_url(b["key"]), esc(b["name"]), esc(b["blurb"]), ICON_ARROW)
        for b in BENCHMARKS)

    company_cards = "".join(
        '<a class="bm-company" href="%s">%s<span class="txt"><span class="n">%s</span>'
        '<span class="s">%d model%s &middot; %s</span></span></a>'
        % (company_url(cid), logo_tile(cid, meta["name"], 22),
           esc(meta["name"]),
           sum(1 for m in MODELS if m["company"] == cid),
           "" if sum(1 for m in MODELS if m["company"] == cid) == 1 else "s",
           esc(meta["country"]))
        for cid, meta in companies_sorted)

    popular = "".join(
        '<a class="bm-vs" href="%s">%s%s<span class="txt"><span class="n">%s vs %s</span>'
        '<span class="s">%s &middot; %s</span></span></a>'
        % (compare_url(a, b),
           logo_tile(BY_SLUG[a]["company"], "", 18, "is-sm"),
           logo_tile(BY_SLUG[b]["company"], "", 18, "is-sm"),
           esc(BY_SLUG[a]["name"]), esc(BY_SLUG[b]["name"]),
           esc(COMPANIES[BY_SLUG[a]["company"]]["name"]),
           esc(COMPANIES[BY_SLUG[b]["company"]]["name"]))
        for a, b in COMPARISONS[:12])

    faqs = [
        ("What is the best AI model right now?",
         "There is no single answer, which is why this page is a table rather than a "
         "ranking. The frontier models — GPT-5, Claude Opus 4.5, Gemini 3 Pro and Grok 4 — "
         "trade places depending on the test: reasoning benchmarks like GPQA Diamond, "
         "agentic coding benchmarks like SWE-bench Verified, and human preference on "
         "LMArena all pick different winners. Sort the table by the column that matches "
         "the work you are actually doing."),
        ("Which AI model is cheapest?",
         "Among capable models, the open-weight ones hosted by third parties are usually "
         "cheapest — DeepSeek, Qwen, GLM and gpt-oss all sit far below the frontier "
         "proprietary models. Sort by <em>In / M</em> or <em>Out / M</em> to see the "
         "current order. Note that reasoning models generate many more output tokens than "
         "their price per token suggests, so a cheap reasoning model can cost more per "
         "answer than an expensive non-reasoning one."),
        ("What does open weights mean?",
         "The lab has published the trained parameters, so you can download the model and "
         "run it on your own hardware. It does not necessarily mean the training data or "
         "code is public, and it does not always mean unrestricted commercial use — the "
         "Licence column records the actual terms, which range from Apache 2.0 and MIT "
         "through to non-commercial and custom community licences."),
        ("Did CorX Labs run these benchmarks?",
         "No. Every score here is a published figure from the lab that built the model or "
         "from a public leaderboard, collected and put in one table. Most benchmark numbers "
         "in this industry are self-reported, and the scaffolding around a model can move a "
         "score by more than the difference between two models. Use them to build a "
         "shortlist, then test the shortlist on your own task."),
        ("How often is this updated?",
         "Each model row records the month it was last checked against its sources. New "
         "models are added as they are released. If you spot a figure that is out of date "
         "or wrong, <a href=\"/contact/\">tell us</a> and it will be corrected."),
        ("Can I compare more than two models?",
         "Yes. Tick the boxes in the leaderboard and press Compare, or open the "
         "<a href=\"/benchmarks/compare/\">comparison tool</a> and add up to four models "
         "side by side."),
    ]
    faq_html = "".join(
        '<details><summary>%s<span class="plus" aria-hidden="true">+</span></summary>'
        '<div class="faq-body"><p>%s</p></div></details>' % (esc(q), a)
        for q, a in faqs)

    body = """
  <div class="shell page-head">
    %(crumbs)s
    <p class="eyebrow" style="margin-bottom:18px">Benchmarks</p>
    <h1>Compare %(n)d AI models, side by side.</h1>
    <p class="lede">Context windows, prices and published benchmark scores for every major
      model from %(nc)d labs — searchable, sortable, and honest about what has not been
      measured.</p>

    <div class="answer-box">
      <p>The CorX Labs benchmark index tracks <strong>%(n)d language models from %(nc)d
        companies</strong>, including OpenAI, Anthropic, Google DeepMind, Meta, Mistral,
        DeepSeek, Alibaba and xAI. For each model it records the context window, the price
        per million input and output tokens, the licence, and published scores on
        %(nb)d standard evaluations — MMLU-Pro, GPQA Diamond, AIME, SWE-bench Verified and
        others. Pick any two to four models to see them column by column.</p>
    </div>

    <div class="btn-row" style="margin-top:26px">
      <a class="btn btn-primary" href="/benchmarks/leaderboard/">See the leaderboard %(arrow)s</a>
      <a class="btn btn-ghost" href="/benchmarks/compare/">Compare models</a>
      <a class="btn btn-ghost" href="#tests">What the tests measure</a>
    </div>
  </div>

  <div class="shell">%(provenance)s</div>

  <section class="section-tight" aria-labelledby="leaderboard-title">
    <div class="shell">
      <div class="section-head" style="max-width:760px">
        <p class="eyebrow">The index</p>
        <h2 id="leaderboard-title">Every model in one table</h2>
        <p>Search by name or maker, filter by capability, and sort by any column. Tick two
          or more rows to compare them properly.</p>
      </div>

      <div class="bm-toolbar">
        <div class="bm-search">
          %(search_icon)s
          <input type="search" id="bm-q" placeholder="Search 153 models — GPT, Claude, Qwen&hellip;"
                 aria-label="Search models by name or maker" autocomplete="off">
        </div>
        <select class="bm-select" id="bm-company" aria-label="Filter by maker">
          <option value="">All makers</option>%(company_options)s
        </select>
        <select class="bm-select" id="bm-sort" aria-label="Sort models">
          <option value="gpqa">Sort: GPQA Diamond</option>
          <option value="mmlu_pro">Sort: MMLU-Pro</option>
          <option value="swe">Sort: SWE-bench Verified</option>
          <option value="aime">Sort: AIME</option>
          <option value="arena">Sort: LMArena Elo</option>
          <option value="ctx">Sort: context window</option>
          <option value="pin">Sort: input price</option>
          <option value="rel">Sort: newest</option>
          <option value="name">Sort: name</option>
        </select>
        <div class="bm-chips">
          <label class="bm-chip"><input type="checkbox" id="bm-open" value="open">Open weights</label>
          <label class="bm-chip"><input type="checkbox" id="bm-reason" value="reason">Reasoning</label>
          <label class="bm-chip"><input type="checkbox" id="bm-vision" value="vision">Vision</label>
        </div>
      </div>

      <p class="bm-result-count" id="bm-count" role="status">
        Showing <strong>%(n)d</strong> of %(n)d models</p>

      %(table)s

      <div class="bm-tray" id="bm-tray" hidden>
        <span class="count"><strong id="bm-tray-n">0</strong> selected</span>
        <span class="picked" id="bm-tray-list"></span>
        <button type="button" class="btn btn-ghost btn-sm" id="bm-tray-clear">Clear</button>
        <a class="btn btn-primary btn-sm" id="bm-tray-go" href="/benchmarks/compare/">Compare %(arrow)s</a>
      </div>
    </div>
  </section>

  <section class="section-tight" id="tests" aria-labelledby="tests-title">
    <div class="shell">
      <div class="section-head">
        <p class="eyebrow">The tests</p>
        <h2 id="tests-title">What each benchmark actually measures</h2>
        <p>A score is only useful if you know what it was measuring. These are the
          %(nb)d evaluations tracked here, and what each one does and does not tell you.</p>
      </div>
      <div class="grid grid-3">%(test_cards)s</div>
    </div>
  </section>

  <section class="section-tight" id="popular" aria-labelledby="popular-title">
    <div class="shell">
      <div class="section-head">
        <p class="eyebrow">Head to head</p>
        <h2 id="popular-title">The comparisons people actually make</h2>
      </div>
      <div class="bm-vs-grid">%(popular)s</div>
      <div class="btn-row" style="margin-top:22px">
        <a class="btn btn-ghost" href="/benchmarks/compare/">Build your own comparison %(arrow)s</a>
      </div>
    </div>
  </section>

  <section class="section-tight" id="companies" aria-labelledby="companies-title">
    <div class="shell">
      <div class="section-head">
        <p class="eyebrow">By maker</p>
        <h2 id="companies-title">%(nc)d labs</h2>
      </div>
      <div class="bm-company-grid">%(company_cards)s</div>
    </div>
  </section>

  <section class="section-tight" id="method" aria-labelledby="method-title">
    <div class="shell">
      <div class="doc-layout">
        <div></div>
        <div class="prose">
          <h2 id="method-title" style="font-family:var(--serif)">Method, and what to distrust</h2>
          <p>This index is a <strong>collection</strong> of published figures, not an
            independent evaluation. That distinction matters more than it sounds, so here is
            exactly what was and was not done.</p>

          <h3>What is collected</h3>
          <p>For every model: the context window and maximum output length, the input and
            output modalities, the licence and whether weights are downloadable, the
            first-party API price per million tokens, the architecture where the lab has
            disclosed it, and the release month. For scores: whatever the lab published in
            its model card, system card, technical report or launch post, plus LMArena Elo
            where the model has been rated.</p>

          <h3>What is not done</h3>
          <p>No evaluation was re-run. No score was estimated, interpolated from a sibling
            model, or carried over from a previous version. Where a lab has not published a
            figure the cell says <em>Not reported</em> and stays empty, even when that leaves
            a gap in an otherwise full row.</p>

          <h3>Why self-reported scores are slippery</h3>
          <ul>
            <li><strong>The scaffold moves the number.</strong> SWE-bench Verified in
              particular is a measure of a whole agent — retrieval, retries, test execution —
              not of a model alone. Two labs reporting the same benchmark may be running very
              different harnesses.</li>
            <li><strong>Attempts vary.</strong> A score taken at pass@1 and one taken with
              majority voting over many samples are not comparable, and the difference is
              often larger than the gap between two models.</li>
            <li><strong>Contamination.</strong> Older benchmarks leak into training data over
              time. HumanEval is effectively saturated; LiveCodeBench exists precisely
              because it collects problems published after a model's cutoff.</li>
            <li><strong>Reasoning budgets.</strong> A model with adjustable thinking can post
              a much higher score at a much higher cost per answer. The price column does not
              capture that, because tokens spent thinking are billed as output.</li>
          </ul>

          <h3>Prices</h3>
          <p>Prices are the standard first-party rate per million tokens, excluding batch
            discounts and cached-input rates unless noted on the model's own page. For
            open-weight models there is no first-party price, so the figure shown is a
            representative third-party hosting rate and is marked as such — the weights
            themselves are free to download.</p>

          <h3>Corrections</h3>
          <p>Every model records the month its row was last verified. If a figure is wrong or
            has been superseded, <a href="/contact/">send a correction</a> with a link to the
            source and it will be updated.</p>

          <h3>Trademarks</h3>
          <p>Company marks are shown to identify each lab's own models. All trademarks belong
            to their respective owners; CorX Labs is not affiliated with, endorsed by, or
            sponsored by any of the companies listed. Logo files are from the
            <a href="https://github.com/lobehub/lobe-icons" rel="noopener" target="_blank">lobe-icons</a>
            (MIT) and <a href="https://simpleicons.org/" rel="noopener" target="_blank">simple-icons</a>
            (CC0) sets.</p>
        </div>
      </div>
    </div>
  </section>

  <section class="section-tight" aria-labelledby="faq-title">
    <div class="shell">
      <div class="section-head">
        <p class="eyebrow">Questions</p>
        <h2 id="faq-title">Common questions</h2>
      </div>
      <div class="faq">%(faq)s</div>
    </div>
  </section>

  <section class="section-tight">
    <div class="shell">
      <div class="cta-band">
        <p class="eyebrow is-plain" style="justify-content:center">CorX Labs</p>
        <h2 class="mt-s">We build models too.</h2>
        <p>CorX3.8-27B is Jamaica's first large open-weight LLM — a 27B Jamaican Patois
          assistant with open weights under Apache 2.0. It is in this index like everything
          else.</p>
        <div class="btn-row">
          <a class="btn btn-primary" href="/models/corx3-8/">See CorX3.8-27B</a>
          <a class="btn btn-ghost" href="/chat/">Try it in the chat</a>
        </div>
      </div>
    </div>
  </section>
""" % {
        "crumbs": crumbs([("/", "Home"), (None, "Benchmarks")]),
        "n": n_models, "nc": n_companies, "nb": len(BENCHMARKS),
        "arrow": ICON_ARROW, "search_icon": ICON_SEARCH,
        "provenance": PROVENANCE,
        "company_options": company_options,
        "table": leaderboard_table(models),
        "test_cards": test_cards, "company_cards": company_cards, "popular": popular,
        "faq": faq_html,
    }

    page_id = SITE + "/benchmarks/#webpage"
    ld = {
        "@context": "https://schema.org",
        "@graph": [
            {
                "@type": "CollectionPage",
                "@id": page_id,
                "url": SITE + "/benchmarks/",
                "name": "AI model benchmarks — compare %d models" % n_models,
                "description": "Context windows, prices and published benchmark scores for "
                               "%d AI models from %d companies." % (n_models, n_companies),
                "isPartOf": {"@id": SITE + "/#website"},
                "inLanguage": "en",
                "dateModified": UPDATED,
                "breadcrumb": {"@id": page_id + "#breadcrumb"},
                "mainEntity": {"@id": SITE + "/benchmarks/#dataset"},
            },
            crumb_ld([("/", "Home"), (None, "Benchmarks")], page_id),
            {
                "@type": "Dataset",
                "@id": SITE + "/benchmarks/#dataset",
                "name": "CorX Labs AI model benchmark index",
                "description": "A collection of published specifications, prices and "
                               "benchmark scores for %d language models from %d labs. "
                               "Scores are self-reported by model developers or taken from "
                               "public leaderboards; CorX Labs did not run the evaluations."
                               % (n_models, n_companies),
                "url": SITE + "/benchmarks/",
                "keywords": ["AI model comparison", "LLM benchmarks", "MMLU-Pro",
                             "GPQA Diamond", "SWE-bench Verified", "context window",
                             "token pricing"],
                "creator": {"@id": SITE + "/#organization"},
                "isAccessibleForFree": True,
                "dateModified": UPDATED,
                "variableMeasured": [b["name"] for b in BENCHMARKS],
            },
            {
                "@type": "FAQPage",
                "@id": SITE + "/benchmarks/#faq",
                "mainEntity": [
                    {"@type": "Question", "name": q,
                     "acceptedAnswer": {"@type": "Answer", "text": _strip_tags(a)}}
                    for q, a in faqs
                ],
            },
        ],
    }

    write("/benchmarks/", page(
        "AI Model Benchmarks — Compare %d Models Side by Side" % n_models,
        "Compare %d AI models from %d labs: context window, price per million tokens, "
        "licence and published scores on MMLU-Pro, GPQA Diamond, AIME and SWE-bench "
        "Verified. Free, sortable, and clear about what has not been measured."
        % (n_models, n_companies),
        SITE + "/benchmarks/", body, jsonld=ld,
        scripts=["/assets/js/benchmarks.js"]))


def _strip_tags(s):
    import re
    return re.sub(r"<[^>]+>", "", s)


# ===========================================================================
# Model pages
# ===========================================================================
def build_model(m):
    co = COMPANIES[m["company"]]
    slug = m["slug"]
    url = SITE + model_url(slug)

    facts = [
        ("Maker", '<a href="%s">%s</a>' % (company_url(m["company"]), esc(co["name"]))),
        ("Released", m.get("rel")),
        ("Parameters", params_label(m)),
        ("Architecture", arch_label(m)),
        ("Context window", "%s tokens" % format(m["ctx"], ",") if m.get("ctx") else None),
        ("Max output", "%s tokens" % format(m["out"], ",") if m.get("out") else None),
        ("Input", modality_label(m.get("inp"))),
        ("Output", modality_label(m.get("outp"))),
        ("Reasoning", "Yes" if m.get("reason") else ("No" if "reason" in m else None)),
        ("Tool calling", "Yes" if m.get("tools") else ("No" if "tools" in m else None)),
        ("Knowledge cutoff", m.get("cut")),
        ("Licence", licence_of(m)),
        ("Weights", "Downloadable" if is_open(m) else "Not released"),
    ]
    facts_html = "".join(
        '<div><dt>%s</dt><dd%s>%s</dd></div>'
        % (esc(label), "" if value else ' class="is-nil"',
           value if (value and "<a" in str(value)) else nil(value))
        for label, value in facts)

    # Pricing
    pin, pout, hosted = m.get("pin"), m.get("pout"), m.get("hosted_price")
    if pin is None and pout is None:
        price_block = (
            '<p>No public API price. %s</p>'
            % ("The weights are published, so the only cost is the hardware you run it on."
               if is_open(m) else "This model is not offered on a public per-token API."))
    else:
        blend = blended_cost(m)
        price_block = (
            '<dl class="bm-keyfacts">'
            '<div><dt>Input</dt><dd>%s <small style="font-weight:400;color:var(--faint)">/ M tokens</small></dd></div>'
            '<div><dt>Output</dt><dd>%s <small style="font-weight:400;color:var(--faint)">/ M tokens</small></dd></div>'
            '%s'
            '<div><dt>Blended 3:1</dt><dd>%s</dd></div>'
            '</dl>'
            '<p style="margin-top:14px;font-size:.9rem;color:var(--muted)">%s</p>'
            % (nil(fmt_price(pin)), nil(fmt_price(pout)),
               ('<div><dt>Cached input</dt><dd>%s</dd></div>' % esc(fmt_price(m["pcache"])))
               if m.get("pcache") is not None else "",
               nil(fmt_price(blend)),
               "This model has open weights, so there is no first-party price. The figures "
               "above are a representative third-party hosting rate — you can also run it "
               "yourself for the cost of the hardware."
               if hosted else
               "Standard first-party API rate, excluding batch discounts. Reasoning models "
               "bill thinking tokens as output, so cost per answer can far exceed the cost "
               "per token suggests."))

    # Benchmarks
    scored = [(b, m.get("b", {}).get(b["key"])) for b in BENCHMARKS]
    have = [(b, v) for b, v in scored if v is not None]
    if have:
        bench_rows = "".join(
            '<tr><th scope="row">%s<span class="hint">%s</span></th>'
            '<td>%s</td><td style="min-width:0;color:var(--muted);font-size:.85rem">%s</td></tr>'
            % ('<a href="%s" style="color:inherit;text-decoration:underline;text-underline-offset:3px">%s</a>'
               % (test_url(b["key"]), esc(b["name"])),
               esc(b["group"]), bench_cell(b["key"], v), esc(_rank_note(m, b["key"], v)))
            for b, v in scored)
        bench_html = ('<div class="bm-compare-wrap"><table class="bm-compare">'
                      '<tbody>%s</tbody></table></div>' % bench_rows)
    else:
        bench_html = (
            '<div class="bm-empty"><strong>No published benchmark scores yet</strong>'
            '%s</div>'
            % ("This model is available by API ID, but its maker has not published a "
               "benchmark card. Nothing has been estimated in its place."
               if m.get("provisional") else
               "Its maker has not published benchmark figures for this model, and nothing "
               "has been estimated in their place."))

    # Head-to-heads
    h2h = head_to_heads_for(slug)
    if h2h:
        vs_html = "".join(
            '<a class="bm-vs" href="%s">%s<span class="txt"><span class="n">vs %s</span>'
            '<span class="s">%s</span></span></a>'
            % (href, logo_tile(BY_SLUG[other]["company"], "", 18, "is-sm"),
               esc(BY_SLUG[other]["name"]), esc(COMPANIES[BY_SLUG[other]["company"]]["name"]))
            for other, href in h2h)
        vs_section = """
  <section class="section-tight" aria-labelledby="vs-title">
    <div class="shell">
      <div class="section-head"><p class="eyebrow">Head to head</p>
        <h2 id="vs-title">%s compared</h2></div>
      <div class="bm-vs-grid">%s</div>
      <div class="btn-row" style="margin-top:20px">
        <a class="btn btn-ghost" href="/benchmarks/compare/?m=%s">Compare with something else %s</a>
      </div>
    </div>
  </section>""" % (esc(m["name"]), vs_html, esc(slug), ICON_ARROW)
    else:
        vs_section = """
  <section class="section-tight">
    <div class="shell">
      <div class="btn-row">
        <a class="btn btn-primary" href="/benchmarks/compare/?m=%s">Compare %s with another model %s</a>
      </div>
    </div>
  </section>""" % (esc(slug), esc(m["name"]), ICON_ARROW)

    siblings = [x for x in MODELS if x["company"] == m["company"] and x["slug"] != slug]
    sib_html = ""
    if siblings:
        sib_html = """
  <section class="section-tight" aria-labelledby="sib-title">
    <div class="shell">
      <div class="section-head"><p class="eyebrow">Same maker</p>
        <h2 id="sib-title">Other models from %s</h2></div>
      %s
    </div>
  </section>""" % (esc(co["name"]), leaderboard_table(
            sorted(siblings, key=lambda x: x.get("rel") or "", reverse=True),
            checkbox=False, table_id="bm-siblings"))

    links = []
    if m.get("hf"):
        links.append('<a class="btn btn-ghost" href="https://huggingface.co/%s" rel="noopener" '
                     'target="_blank">Weights on Hugging Face %s</a>' % (esc(m["hf"]), ICON_EXTERNAL))
    if m.get("local"):
        links.append('<a class="btn btn-primary" href="%s">Full model page %s</a>'
                     % (m["local"], ICON_ARROW))
    if co.get("site"):
        links.append('<a class="btn btn-ghost" href="https://%s" rel="noopener" target="_blank">'
                     '%s %s</a>' % (esc(co["site"]), esc(co["name"]), ICON_EXTERNAL))

    body = """
  <div class="shell page-head">
    %(crumbs)s
    <div class="bm-model-head">
      %(logo)s
      <div>
        <h1>%(name)s</h1>
        <span class="maker">by <a href="%(courl)s">%(coname)s</a> &middot; %(country)s</span>
      </div>
    </div>
    <div style="margin-top:20px">%(tags)s</div>
    <p class="lede" style="margin-top:20px">%(desc)s</p>
  </div>

  <div class="shell"><hr class="rule"></div>

  <section class="section-tight" aria-labelledby="spec-title">
    <div class="shell">
      <div class="section-head" style="margin-bottom:26px">
        <p class="eyebrow">Specification</p>
        <h2 id="spec-title">The numbers</h2>
      </div>
      <dl class="bm-keyfacts">%(facts)s</dl>
      %(api_id)s
    </div>
  </section>

  <section class="section-tight" aria-labelledby="price-title">
    <div class="shell">
      <div class="section-head" style="margin-bottom:22px">
        <p class="eyebrow">Cost</p>
        <h2 id="price-title">Price per million tokens</h2>
      </div>
      %(price)s
    </div>
  </section>

  <section class="section-tight" aria-labelledby="bench-title">
    <div class="shell">
      <div class="section-head" style="margin-bottom:22px">
        <p class="eyebrow">Published scores</p>
        <h2 id="bench-title">Benchmarks</h2>
        <p>Figures published by %(coname)s or taken from a public leaderboard. Row last
          checked %(verified)s.</p>
      </div>
      %(profile)s
      <h3 style="font-family:var(--sans);font-size:.74rem;font-weight:600;letter-spacing:.11em;
                 text-transform:uppercase;color:var(--faint);margin:36px 0 14px">Every reported test</h3>
      %(bench)s
      <div style="margin-top:22px">%(provenance)s</div>
    </div>
  </section>
%(vs)s%(siblings)s
  <section class="section-tight">
    <div class="shell">
      <div class="btn-row">%(links)s</div>
    </div>
  </section>
""" % {
        "crumbs": crumbs([("/", "Home"), ("/benchmarks/", "Benchmarks"),
                          ("/benchmarks/#companies", co["name"]), (None, m["name"])]),
        "logo": logo_tile(m["company"], co["name"], 34, "is-lg", lazy=False),
        "name": esc(m["name"]), "courl": company_url(m["company"]),
        "coname": esc(co["name"]), "country": esc(co["country"]),
        "tags": tag_row(m), "desc": esc(m.get("desc", "")),
        "facts": facts_html,
        "api_id": ('<p style="margin-top:16px;font-size:.88rem;color:var(--muted)">'
                   'API model ID: <code>%s</code></p>' % esc(m["api_id"]))
                  if m.get("api_id") else "",
        "price": price_block, "bench": bench_html,
        "profile": category_profile(m, MODELS) if m.get("b") else "",
        "verified": esc(m.get("verified", "recently")),
        "provenance": PROVENANCE, "vs": vs_section, "siblings": sib_html,
        "links": "".join(links),
    }

    page_id = url + "#webpage"
    app = {
        "@type": "SoftwareApplication",
        "@id": url + "#model",
        "name": m["name"],
        "url": url,
        "applicationCategory": "DeveloperApplication",
        "applicationSubCategory": "Large language model",
        "operatingSystem": "Cross-platform",
        "description": m.get("desc", ""),
        "author": {"@type": "Organization", "name": co["name"]},
    }
    if m.get("lic"):
        app["license"] = m["lic"]
    if m.get("pin") is not None:
        app["offers"] = {"@type": "Offer", "price": str(m["pin"]), "priceCurrency": "USD",
                         "description": "USD per million input tokens"}
    ratings = [
        {"@type": "PropertyValue", "name": BENCH_BY_KEY[k]["name"], "value": v}
        for k, v in (m.get("b") or {}).items()
    ]
    if ratings:
        app["additionalProperty"] = ratings

    ld = {"@context": "https://schema.org", "@graph": [
        {"@type": "WebPage", "@id": page_id, "url": url,
         "name": "%s — specs, price and benchmarks" % m["name"],
         "isPartOf": {"@id": SITE + "/#website"}, "inLanguage": "en",
         "dateModified": UPDATED, "breadcrumb": {"@id": page_id + "#breadcrumb"},
         "mainEntity": {"@id": url + "#model"}},
        crumb_ld([("/", "Home"), ("/benchmarks/", "Benchmarks"), (None, m["name"])], page_id),
        app,
    ]}

    desc_bits = []
    if m.get("ctx"):
        desc_bits.append("%s context" % fmt_tokens(m["ctx"]))
    if m.get("pin") is not None:
        desc_bits.append("%s per million input tokens" % fmt_price(m["pin"]))
    desc_bits.append("open weights" if is_open(m) else "proprietary")
    meta_desc = "%s by %s: %s. Published benchmark scores, full specification and side-by-side comparisons." % (
        m["name"], co["name"], ", ".join(desc_bits))

    write(model_url(slug), page(
        "%s — Specs, Pricing and Benchmarks" % m["name"],
        meta_desc, url, body, jsonld=ld, og_image="og-model.jpg"))


def _rank_note(m, key, value):
    """Where this score sits among every model that reported the same test."""
    if value is None:
        return "No figure published"
    peers = sorted((x.get("b", {}).get(key) for x in MODELS
                    if x.get("b", {}).get(key) is not None), reverse=True)
    if len(peers) < 3:
        return "%d of %d models report this" % (peers.index(value) + 1, len(peers))
    rank = peers.index(value) + 1
    return "Rank %d of %d models reporting" % (rank, len(peers))


# ===========================================================================
# Head-to-head pages
# ===========================================================================
SPEC_ROWS = [
    ("Maker", "Who built it", lambda m: COMPANIES[m["company"]]["name"]),
    ("Released", None, lambda m: m.get("rel")),
    ("Parameters", "Total, and active per token for a mixture of experts",
     lambda m: params_label(m)),
    ("Architecture", None, lambda m: arch_label(m)),
    ("Context window", "How much can go in at once",
     lambda m: ("%s tokens" % format(m["ctx"], ",")) if m.get("ctx") else None),
    ("Max output", None, lambda m: ("%s tokens" % format(m["out"], ",")) if m.get("out") else None),
    ("Input", None, lambda m: modality_label(m.get("inp"))),
    ("Reasoning", "Spends extra tokens thinking before it answers",
     lambda m: "Yes" if m.get("reason") else ("No" if "reason" in m else None)),
    ("Tool calling", None, lambda m: "Yes" if m.get("tools") else ("No" if "tools" in m else None)),
    ("Knowledge cutoff", None, lambda m: m.get("cut")),
    ("Licence", None, lambda m: licence_of(m)),
    ("Open weights", "Can you download and run it yourself",
     lambda m: "Yes" if is_open(m) else "No"),
]

PRICE_ROWS = [
    ("Input price", "USD per million tokens in", lambda m: fmt_price(m.get("pin")), False),
    ("Output price", "USD per million tokens out", lambda m: fmt_price(m.get("pout")), False),
    ("Cached input", None, lambda m: fmt_price(m.get("pcache")), False),
    ("Blended 3:1", "A 3-in-to-1-out million-token mix — a fairer single number than input price alone",
     lambda m: fmt_price(blended_cost(m)), True),
]


def compare_columns(models, drop_buttons=False):
    """The shared table for both the static head-to-heads and the live tool."""
    heads = ['<th class="bm-corner"><span class="visually-hidden">Attribute</span></th>']
    for m in models:
        co = COMPANIES[m["company"]]
        drop = ('<button type="button" class="drop" data-drop="%s">Remove</button>' % esc(m["slug"])
                ) if drop_buttons else ""
        heads.append(
            '<th scope="col"><span class="bm-colhead"><span class="top">%s'
            '<span><a class="title" href="%s">%s</a>'
            '<span class="maker">%s</span></span></span>%s</span></th>'
            % (logo_tile(m["company"], co["name"], 24), model_url(m["slug"]),
               esc(m["name"]), esc(co["name"]), drop))

    sections = []

    def add_section(label, rows):
        sections.append('<tr><th scope="row" style="background:var(--paper-sunk);'
                        'color:var(--espresso);font-weight:600">%s</th>%s</tr>'
                        % (esc(label), '<td style="background:var(--paper-sunk)"></td>' * len(models)))
        sections.extend(rows)

    # Specification
    spec_rows = []
    for label, hint, getter in SPEC_ROWS:
        values = [getter(m) for m in models]
        if all(v is None for v in values):
            continue
        cells = "".join('<td%s>%s</td>' % ("" if v else ' class="is-nil"', nil(v)) for v in values)
        spec_rows.append('<tr><th scope="row">%s%s</th>%s</tr>'
                         % (esc(label), ('<span class="hint">%s</span>' % esc(hint)) if hint else "",
                            cells))
    add_section("Specification", spec_rows)

    # Price — lower is better, so the winner is the minimum
    price_rows = []
    for label, hint, getter, mark_best in PRICE_ROWS:
        raw = []
        for m in models:
            v = getter(m)
            raw.append(v)
        if all(v is None for v in raw):
            continue
        numeric = [blended_cost(m) if label == "Blended 3:1" else
                   (m.get("pin") if label == "Input price" else
                    m.get("pout") if label == "Output price" else m.get("pcache"))
                   for m in models]
        known = [x for x in numeric if x is not None]
        best_val = min(known) if (mark_best and len(known) > 1 and len(set(known)) > 1) else None
        cells = ""
        for v, n in zip(raw, numeric):
            win = best_val is not None and n == best_val
            cells += '<td%s>%s%s</td>' % (
                ' class="bm-best"' if win else ("" if v else ' class="is-nil"'),
                nil(v), '<span class="bm-best-tag">Cheapest</span>' if win else "")
        price_rows.append('<tr><th scope="row">%s%s</th>%s</tr>'
                          % (esc(label), ('<span class="hint">%s</span>' % esc(hint)) if hint else "",
                             cells))
    hosted = [m for m in models if m.get("hosted_price")]
    if hosted:
        price_rows.append(
            '<tr><th scope="row">Price note</th>%s</tr>'
            % "".join('<td style="font-size:.84rem;color:var(--muted)">%s</td>'
                      % ("Open weights — this is a representative hosting rate, not a "
                         "first-party price. Running it yourself costs only hardware."
                         if m.get("hosted_price") else "First-party API rate.")
                      for m in models))
    add_section("Price", price_rows)

    # Benchmarks — higher is better
    bench_rows = []
    for b in BENCHMARKS:
        vals = [m.get("b", {}).get(b["key"]) for m in models]
        if all(v is None for v in vals):
            continue
        known = [v for v in vals if v is not None]
        best = max(known) if len(known) > 1 and len(set(known)) > 1 else None
        cells = "".join('<td>%s</td>' % bench_cell(b["key"], v, best is not None and v == best)
                        for v in vals)
        bench_rows.append(
            '<tr><th scope="row"><a href="%s" style="color:inherit;text-decoration:underline;'
            'text-underline-offset:3px">%s</a><span class="hint">%s</span></th>%s</tr>'
            % (test_url(b["key"]), esc(b["name"]), esc(b["blurb"]), cells))
    if bench_rows:
        add_section("Published benchmarks", bench_rows)
    else:
        add_section("Published benchmarks", [
            '<tr><th scope="row">Scores</th>%s</tr>'
            % "".join('<td class="is-nil">No published figures</td>' for _ in models)])

    # Links
    link_cells = ""
    for m in models:
        bits = []
        if m.get("hf"):
            bits.append('<a href="https://huggingface.co/%s" rel="noopener" target="_blank" '
                        'style="text-decoration:underline;text-underline-offset:3px">'
                        'Hugging Face</a>' % esc(m["hf"]))
        bits.append('<a href="%s" style="text-decoration:underline;text-underline-offset:3px">'
                    'Full page</a>' % model_url(m["slug"]))
        link_cells += '<td style="font-size:.86rem">%s</td>' % " &middot; ".join(bits)
    sections.append('<tr><th scope="row">Links</th>%s</tr>' % link_cells)
    sections.append('<tr><th scope="row">Row verified</th>%s</tr>'
                    % "".join('<td style="font-size:.86rem;color:var(--muted)">%s</td>'
                              % esc(m.get("verified", "—")) for m in models))

    return ('<div class="bm-compare-wrap"><table class="bm-compare">'
            '<thead><tr>%s</tr></thead><tbody>%s</tbody></table></div>'
            % ("".join(heads), "".join(sections)))


def verdict(a, b):
    """Honest summary sentences, derived only from data that exists."""
    wins_a = wins_b = ties = 0
    shared = []
    for bench in BENCHMARKS:
        va = a.get("b", {}).get(bench["key"])
        vb = b.get("b", {}).get(bench["key"])
        if va is None or vb is None:
            continue
        shared.append((bench, va, vb))
        if va > vb:
            wins_a += 1
        elif vb > va:
            wins_b += 1
        else:
            ties += 1

    if not shared:
        bench_head = "No shared benchmarks"
        bench_txt = ("These two models have no benchmark in common with published figures "
                     "for both, so there is nothing to compare directly. The specification "
                     "and price rows below are still like for like.")
    elif wins_a == wins_b:
        bench_head = "Evenly split"
        bench_txt = ("Across the %d benchmark%s both models report, they are level — "
                     "%s takes %d and %s takes %d. Which one is better depends entirely on "
                     "which test resembles your work."
                     % (len(shared), "" if len(shared) == 1 else "s",
                        a["name"], wins_a, b["name"], wins_b))
    else:
        lead, trail, lw, tw = ((a, b, wins_a, wins_b) if wins_a > wins_b
                               else (b, a, wins_b, wins_a))
        gaps = [abs(va - vb) for _, va, vb in shared]
        avg_gap = sum(gaps) / len(gaps)
        margin = ("by a wide margin" if avg_gap >= 8 else
                  "though the gaps are small" if avg_gap < 2.5 else "consistently")
        bench_head = "%s leads" % lead["name"]
        bench_txt = ("%s wins %d of the %d benchmarks both models report, %s wins %d, %s. "
                     "The average gap across shared tests is %.1f points."
                     % (lead["name"], lw, len(shared), trail["name"], tw, margin, avg_gap))

    # Price
    ca, cb = blended_cost(a), blended_cost(b)
    if ca is None or cb is None:
        price_head = "Not directly comparable"
        price_txt = ("At least one of these does not have a published per-token price, so "
                     "cost cannot be compared like for like. %s"
                     % ("The open-weight model can be run on your own hardware instead."
                        if (is_open(a) or is_open(b)) else ""))
    elif abs(ca - cb) < 1e-9:
        price_head = "Same price"
        price_txt = "Both cost %s per million tokens on a 3:1 input-to-output mix." % fmt_price(ca)
    else:
        cheap, dear, cc, dc = ((a, b, ca, cb) if ca < cb else (b, a, cb, ca))
        ratio = dc / cc if cc else 0
        price_head = "%s is cheaper" % cheap["name"]
        price_txt = ("On a 3:1 input-to-output mix, %s costs %s per million tokens against "
                     "%s for %s — %s. %s"
                     % (cheap["name"], fmt_price(cc), fmt_price(dc), dear["name"],
                        ("about %.1f&times; less" % ratio) if ratio >= 1.15 else "a small difference",
                        "Remember that a reasoning model bills its thinking as output, so "
                        "cost per answer can diverge much further than cost per token."
                        if (a.get("reason") or b.get("reason")) else ""))

    # Practical
    notes = []
    if is_open(a) != is_open(b):
        opener = a if is_open(a) else b
        notes.append("<strong>%s has open weights</strong> under %s, so it can run on your "
                     "own hardware with no per-token cost and no dependency on an API staying "
                     "available. The other is API-only."
                     % (opener["name"], licence_of(opener)))
    if a.get("ctx") and b.get("ctx") and a["ctx"] != b["ctx"]:
        big, small = ((a, b) if a["ctx"] > b["ctx"] else (b, a))
        notes.append("<strong>%s takes %s tokens</strong> of context against %s — %.1f&times; "
                     "more room for long documents or a large codebase."
                     % (big["name"], fmt_tokens(big["ctx"]), fmt_tokens(small["ctx"]),
                        big["ctx"] / small["ctx"]))
    if bool(a.get("reason")) != bool(b.get("reason")):
        r = a if a.get("reason") else b
        notes.append("<strong>%s is a reasoning model</strong> and the other is not, which "
                     "usually means better maths and multi-step logic in exchange for higher "
                     "latency and more billed output tokens." % r["name"])
    va, vb = "image" in (a.get("inp") or []), "image" in (b.get("inp") or [])
    if va != vb:
        v = a if va else b
        notes.append("<strong>Only %s reads images.</strong> If your input includes "
                     "screenshots, charts or documents, that decides it." % v["name"])
    if not notes:
        notes.append("These two are closely matched on the specification side — same broad "
                     "capabilities, same licensing posture. The decision comes down to the "
                     "benchmark rows and the price.")

    return ((bench_head, bench_txt), (price_head, price_txt), notes)


def build_comparison(a_slug, b_slug):
    a, b = BY_SLUG[a_slug], BY_SLUG[b_slug]
    url = SITE + compare_url(a_slug, b_slug)
    title_pair = "%s vs %s" % (a["name"], b["name"])
    (bh, bt), (ph, pt), notes = verdict(a, b)

    other_a = [(o, h) for o, h in head_to_heads_for(a_slug) if o != b_slug][:4]
    other_b = [(o, h) for o, h in head_to_heads_for(b_slug) if o != a_slug][:4]
    related = other_a + other_b
    seen, rel_html = set(), ""
    for other, href in related:
        if href in seen:
            continue
        seen.add(href)
        o = BY_SLUG[other]
        rel_html += ('<a class="bm-vs" href="%s">%s<span class="txt">'
                     '<span class="n">%s</span><span class="s">%s</span></span></a>'
                     % (href, logo_tile(o["company"], "", 18, "is-sm"),
                        esc(href.strip("/").split("/")[-1].replace("-vs-", " vs ")),
                        esc(COMPANIES[o["company"]]["name"])))

    faqs = [
        ("Is %s better than %s?" % (a["name"], b["name"]), _strip_tags(bt)),
        ("Which is cheaper, %s or %s?" % (a["name"], b["name"]), _strip_tags(pt)),
        ("What is the difference between %s and %s?" % (a["name"], b["name"]),
         _strip_tags(" ".join(notes))),
    ]
    faq_html = "".join(
        '<details><summary>%s<span class="plus" aria-hidden="true">+</span></summary>'
        '<div class="faq-body"><p>%s</p></div></details>' % (esc(q), esc(ans))
        for q, ans in faqs)

    body = """
  <div class="shell page-head">
    %(crumbs)s
    <p class="eyebrow" style="margin-bottom:18px">Head to head</p>
    <h1>%(a)s vs %(b)s</h1>
    <p class="lede">%(a)s from %(coa)s against %(b)s from %(cob)s — specification, price and
      every benchmark both makers have published, in one table.</p>
  </div>

  <section class="section-tight" style="padding-top:0">
    <div class="shell">
      <div class="bm-verdict">
        <div>
          <h3>Benchmarks</h3>
          <p class="headline">%(bh)s</p>
          <p>%(bt)s</p>
        </div>
        <div>
          <h3>Price</h3>
          <p class="headline">%(ph)s</p>
          <p>%(pt)s</p>
        </div>
        <div>
          <h3>What actually differs</h3>
          <ul class="fact-list" style="margin-top:2px">%(notes)s</ul>
        </div>
      </div>
    </div>
  </section>

  <section class="section-tight" style="padding-top:0" aria-labelledby="score-title">
    <div class="shell">
      <div class="section-head" style="margin-bottom:22px">
        <p class="eyebrow">Scorecard</p>
        <h2 id="score-title">Which is better at what</h2>
        <p>Maths, coding, reasoning and the rest — one line each, averaged over the benchmarks
          both models actually report.</p>
      </div>
      %(scorecard)s
    </div>
  </section>

  <section class="section-tight" style="padding-top:0" aria-labelledby="table-title">
    <div class="shell">
      <div class="section-head" style="margin-bottom:22px">
        <p class="eyebrow">Side by side</p>
        <h2 id="table-title">%(a)s and %(b)s, row by row</h2>
      </div>
      %(table)s
      <div style="margin-top:24px">%(provenance)s</div>
      <div class="btn-row" style="margin-top:22px">
        <a class="btn btn-primary" href="/benchmarks/compare/?m=%(sa)s,%(sb)s">Add a third model %(arrow)s</a>
        <a class="btn btn-ghost" href="/benchmarks/">Back to all models</a>
      </div>
    </div>
  </section>

  <section class="section-tight" aria-labelledby="faq-title">
    <div class="shell">
      <div class="section-head"><p class="eyebrow">Questions</p>
        <h2 id="faq-title">%(a)s or %(b)s?</h2></div>
      <div class="faq">%(faq)s</div>
    </div>
  </section>
%(related)s""" % {
        "crumbs": crumbs([("/", "Home"), ("/benchmarks/", "Benchmarks"),
                          ("/benchmarks/compare/", "Compare"), (None, title_pair)]),
        "a": esc(a["name"]), "b": esc(b["name"]),
        "coa": esc(COMPANIES[a["company"]]["name"]), "cob": esc(COMPANIES[b["company"]]["name"]),
        "bh": esc(bh), "bt": bt, "ph": esc(ph), "pt": pt,
        "notes": "".join("<li>%s</li>" % n for n in notes),
        "table": compare_columns([a, b]),
        "scorecard": scorecard([a, b]),
        "provenance": PROVENANCE, "faq": faq_html,
        "sa": esc(a_slug), "sb": esc(b_slug), "arrow": ICON_ARROW,
        "related": ("""
  <section class="section-tight" aria-labelledby="rel-title">
    <div class="shell">
      <div class="section-head"><p class="eyebrow">Related</p>
        <h2 id="rel-title">Other comparisons</h2></div>
      <div class="bm-vs-grid">%s</div>
    </div>
  </section>""" % rel_html) if rel_html else "",
    }

    page_id = url + "#webpage"
    ld = {"@context": "https://schema.org", "@graph": [
        {"@type": "WebPage", "@id": page_id, "url": url,
         "name": "%s — benchmarks, price and specs compared" % title_pair,
         "isPartOf": {"@id": SITE + "/#website"}, "inLanguage": "en",
         "dateModified": UPDATED, "breadcrumb": {"@id": page_id + "#breadcrumb"},
         "about": [{"@type": "SoftwareApplication", "name": a["name"],
                    "url": SITE + model_url(a_slug)},
                   {"@type": "SoftwareApplication", "name": b["name"],
                    "url": SITE + model_url(b_slug)}]},
        crumb_ld([("/", "Home"), ("/benchmarks/", "Benchmarks"),
                  ("/benchmarks/compare/", "Compare"), (None, title_pair)], page_id),
        {"@type": "FAQPage", "@id": url + "#faq", "mainEntity": [
            {"@type": "Question", "name": q,
             "acceptedAnswer": {"@type": "Answer", "text": ans}} for q, ans in faqs]},
    ]}

    write(compare_url(a_slug, b_slug), page(
        "%s — Benchmarks, Price and Specs Compared" % title_pair,
        "%s or %s? Compare context window, price per million tokens, licence and published "
        "scores on MMLU-Pro, GPQA Diamond, AIME and SWE-bench Verified, side by side."
        % (a["name"], b["name"]),
        url, body, jsonld=ld, og_image="og-compare.jpg"))


# ===========================================================================
# Interactive compare tool
# ===========================================================================
def build_compare_tool():
    url = SITE + "/benchmarks/compare/"
    default = COMPARISONS[0]
    popular = "".join(
        '<a class="bm-vs" href="%s">%s%s<span class="txt"><span class="n">%s vs %s</span>'
        '<span class="s">%s &middot; %s</span></span></a>'
        % (compare_url(a, b),
           logo_tile(BY_SLUG[a]["company"], "", 18, "is-sm"),
           logo_tile(BY_SLUG[b]["company"], "", 18, "is-sm"),
           esc(BY_SLUG[a]["name"]), esc(BY_SLUG[b]["name"]),
           esc(COMPANIES[BY_SLUG[a]["company"]]["name"]),
           esc(COMPANIES[BY_SLUG[b]["company"]]["name"]))
        for a, b in COMPARISONS[:18])

    body = """
  <div class="shell page-head">
    %(crumbs)s
    <p class="eyebrow" style="margin-bottom:18px">Compare</p>
    <h1>Put any models side by side.</h1>
    <p class="lede">Choose up to four of the %(n)d models in the index and see specification,
      price and every published benchmark in one table.</p>
  </div>

  <section class="section-tight" style="padding-top:0">
    <div class="shell">
      <div class="bm-toolbar" style="margin-bottom:16px">
        <div class="bm-picker" id="bm-picker">
          <button type="button" class="btn btn-primary" id="bm-add" aria-haspopup="listbox"
                  aria-expanded="false" aria-controls="bm-picker-panel">Add a model</button>
          <div class="bm-picker-panel" id="bm-picker-panel" hidden role="listbox"
               aria-label="Choose a model">
            <input type="search" id="bm-picker-q" placeholder="Search models&hellip;"
                   aria-label="Search models" autocomplete="off">
            <div id="bm-picker-list"></div>
          </div>
        </div>
        <button type="button" class="btn btn-ghost" id="bm-reset">Start over</button>
        <button type="button" class="btn btn-ghost" id="bm-copy"
                data-label="Copy link">Copy link</button>
      </div>

      <div id="bm-compare-root" aria-live="polite">
        <noscript>
          <div class="bm-provenance" style="border-left-color:var(--espresso)">
            %(info)s
            <div>
              <h2>This tool needs JavaScript</h2>
              <p>The pre-built comparisons below work without it, and every model has its own
                page with the same specification and benchmark tables.</p>
            </div>
          </div>
        </noscript>
      </div>

      <div style="margin-top:26px">%(provenance)s</div>
    </div>
  </section>

  <section class="section-tight" aria-labelledby="popular-title">
    <div class="shell">
      <div class="section-head">
        <p class="eyebrow">Ready made</p>
        <h2 id="popular-title">Popular comparisons</h2>
        <p>Each of these is a full static page — no JavaScript needed.</p>
      </div>
      <div class="bm-vs-grid">%(popular)s</div>
      <div class="btn-row" style="margin-top:22px">
        <a class="btn btn-ghost" href="/benchmarks/">Browse all %(n)d models %(arrow)s</a>
      </div>
    </div>
  </section>
""" % {
        "crumbs": crumbs([("/", "Home"), ("/benchmarks/", "Benchmarks"), (None, "Compare")]),
        "n": len(MODELS), "provenance": PROVENANCE, "popular": popular,
        "arrow": ICON_ARROW, "info": ICON_INFO,
    }

    page_id = url + "#webpage"
    ld = {"@context": "https://schema.org", "@graph": [
        {"@type": "WebPage", "@id": page_id, "url": url,
         "name": "Compare AI models side by side",
         "isPartOf": {"@id": SITE + "/#website"}, "inLanguage": "en",
         "dateModified": UPDATED, "breadcrumb": {"@id": page_id + "#breadcrumb"}},
        crumb_ld([("/", "Home"), ("/benchmarks/", "Benchmarks"), (None, "Compare")], page_id),
    ]}

    write("/benchmarks/compare/", page(
        "Compare AI Models Side by Side — Specs, Price and Benchmarks",
        "Choose up to four of %d AI models and compare context window, price per million "
        "tokens, licence and published benchmark scores in a single table." % len(MODELS),
        url, body, jsonld=ld, og_image="og-compare.jpg",
        scripts=["/assets/js/benchmarks.js"]))


# ===========================================================================
# Leaderboard — top models across every field
# ===========================================================================
def build_leaderboard():
    url = SITE + "/benchmarks/leaderboard/"
    entries, standings = overall_standings(MODELS)
    top = entries[:40]

    # --- overall table ---
    rows = []
    for i, e in enumerate(top, start=1):
        m = e["model"]
        co = COMPANIES[m["company"]]
        medal = ' class="bm-lb-podium"' if i <= 3 else ""
        rows.append(
            '<tr%s><td class="bm-num bm-lb-rank">%d</td>'
            '<td><span class="bm-model-cell">%s<span class="names">'
            '<a class="name" href="%s">%s</a><span class="maker">%s</span></span></span></td>'
            '<td class="bm-num">%d<span class="bm-lb-of"> / %d</span></td>'
            '<td class="bm-num"><strong>%.0f</strong></td>'
            '<td class="bm-num">%s</td>'
            '<td>%s <span class="bm-lb-of">#%d of %d</span></td></tr>'
            % (medal, i, logo_tile(m["company"], "", 19, "is-sm"), model_url(m["slug"]),
               esc(m["name"]), esc(co["name"]),
               len(e["fields"]), len(CATEGORY_ORDER), e["avg"],
               e["tops"] if e["tops"] else '<span class="bm-nil">0</span>',
               esc(e["best"]), e["best_rank"], e["best_n"]))

    overall_table = """<div class="bm-table-wrap">
  <table class="bm-table bm-leaderboard-table">
    <caption class="visually-hidden">AI models ranked by average percentile across the capability fields they report.</caption>
    <thead><tr>
      <th class="bm-num" scope="col">#</th>
      <th scope="col">Model</th>
      <th class="bm-num" scope="col">Fields</th>
      <th class="bm-num" scope="col">Avg. percentile</th>
      <th class="bm-num" scope="col">Top-3 finishes</th>
      <th scope="col">Strongest field</th>
    </tr></thead>
    <tbody>%s</tbody>
  </table>
</div>""" % "".join(rows)

    # --- per-field podiums ---
    blocks = []
    for group in CATEGORY_ORDER:
        rank = standings[group]
        if not rank:
            continue
        primary = BENCH_BY_KEY[FIELD_PRIMARY[group]]
        items = "".join(
            '<li><span class="p">%d</span>%s<span class="txt">'
            '<a class="n" href="%s">%s</a><span class="s">%s</span></span>'
            '<span class="v">%s</span></li>'
            % (i, logo_tile(m["company"], "", 18, "is-sm"), model_url(m["slug"]),
               esc(m["name"]), esc(COMPANIES[m["company"]]["name"]),
               esc(fmt_category(unit, v)))
            for i, (m, v, unit, pct) in enumerate(rank[:5], start=1))
        blocks.append(
            '<div class="bm-field"><div class="bm-field-head"><h3>%s</h3>'
            '<p>%s</p><p class="tests">Ranked on <a href="%s">%s</a> '
            '&middot; %d models reporting</p></div>'
            '<ol class="bm-field-list">%s</ol></div>'
            % (esc(group), esc(CATEGORY_BLURB[group]), test_url(primary["key"]),
               esc(primary["name"]), len(rank), items))

    faqs = [
        ("How is this leaderboard ranked?",
         "Each field is decided by one benchmark, named in that field's header, and every model "
         "listed in it reported that same benchmark. Models are ranked within the field and given "
         "a percentile — the share of the field they are at least as good as. A model's overall "
         "position is the average of its percentiles across the fields it reports. Percentiles "
         "rather than raw ranks, because a field with 83 reporting models and one with 15 would "
         "otherwise reward the same achievement very differently."),
        ("Why does each field use only one benchmark?",
         "Because averaging a whole group would rank on which test a lab chose rather than on "
         "capability. HumanEval is saturated near 92% while SWE-bench Verified sits around 80% for "
         "the same class of model, so a model that published only the easy one would float to the "
         "top of Coding. One deciding benchmark per field means every model in a list sat the same "
         "test. The other benchmarks in each group are still shown on model pages and in "
         "side-by-side comparisons."),
        ("Why do some well-known models not appear?",
         "A model has to report at least %d of the seven fields to be ranked. Below that, one "
         "strong benchmark would outrank a model measured across six, which would make the table "
         "misleading. Models under the threshold still have their own pages and still appear in "
         "the per-field lists below." % MIN_FIELDS),
        ("Is this a measure of which model is best?",
         "No. It is a measure of which models published the best numbers on the tests they chose "
         "to publish. That is a real signal and a limited one — a lab can decline to report a "
         "benchmark it does badly on, and no one here re-ran anything. Read the per-field lists "
         "before the overall table; they are closer to the truth."),
        ("What are the seven fields?",
         "Reasoning, Maths, Coding, Knowledge, Multimodal, Instruction following and Human "
         "preference. Each groups the benchmarks that measure the same thing, and a model's field "
         "score averages the ones it reports in that group."),
    ]
    faq_html = "".join(
        '<details><summary>%s<span class="plus" aria-hidden="true">+</span></summary>'
        '<div class="faq-body"><p>%s</p></div></details>' % (esc(q), esc(a))
        for q, a in faqs)

    leader = top[0] if top else None
    body = """
  <div class="shell page-head">
    %(crumbs)s
    <p class="eyebrow" style="margin-bottom:18px">Leaderboard</p>
    <h1>The top models, field by field.</h1>
    <p class="lede">One ranking across reasoning, maths, coding, knowledge, multimodal,
      instruction following and human preference — built from published figures, and honest about
      what that can and cannot tell you.</p>

    <div class="answer-box">
      <p>Across the %(nfields)d capability fields tracked here, <strong>%(leader)s</strong> holds the
        highest average percentile among models reporting at least %(minf)d fields. Rankings are
        computed per field and then averaged, never rolled into a single invented score. %(nranked)d
        of the %(total)d models in the index clear the reporting threshold.</p>
    </div>

    <div class="btn-row" style="margin-top:24px">
      <a class="btn btn-primary" href="#fields">Jump to the field leaders %(arrow)s</a>
      <a class="btn btn-ghost" href="/benchmarks/">Browse all %(total)d models</a>
    </div>
  </div>

  <div class="shell">%(provenance)s</div>

  <section class="section-tight" aria-labelledby="overall-title">
    <div class="shell">
      <div class="section-head" style="max-width:760px">
        <p class="eyebrow">Overall</p>
        <h2 id="overall-title">Best across every field</h2>
        <p>Ranked by average percentile across the fields each model reports. <strong>Fields</strong>
          shows how many of the %(nfields)d it reports at all — a high average over three fields is a
          narrower claim than the same average over six, and the column is there so you can see
          which you are looking at.</p>
      </div>
      %(overall)s
      <p class="bm-sc-note">Showing the top %(ntop)d of %(nranked)d ranked models. A model needs at
        least %(minf)d of %(nfields)d fields to be ranked at all.</p>
    </div>
  </section>

  <section class="section-tight" id="fields" aria-labelledby="fields-title">
    <div class="shell">
      <div class="section-head">
        <p class="eyebrow">Field leaders</p>
        <h2 id="fields-title">Who leads what</h2>
        <p>The top five in each field, with the score that put them there. These lists are the more
          reliable half of this page — no averaging across fields, no threshold, just the published
          numbers in order.</p>
      </div>
      <div class="bm-field-grid">%(fields)s</div>
    </div>
  </section>

  <section class="section-tight" aria-labelledby="lb-faq-title">
    <div class="shell">
      <div class="section-head">
        <p class="eyebrow">Method</p>
        <h2 id="lb-faq-title">How to read this</h2>
      </div>
      <div class="faq">%(faq)s</div>
    </div>
  </section>

  <section class="section-tight">
    <div class="shell">
      <div class="cta-band">
        <p class="eyebrow is-plain" style="justify-content:center">Compare</p>
        <h2 class="mt-s">A ranking is not a decision.</h2>
        <p>Pick the two or three models this page put in front of you and read them column by
          column — price, context, licence and every benchmark side by side.</p>
        <div class="btn-row">
          <a class="btn btn-primary" href="/benchmarks/compare/">Open the comparison tool</a>
          <a class="btn btn-ghost" href="/benchmarks/">All %(total)d models</a>
        </div>
      </div>
    </div>
  </section>
""" % {
        "crumbs": crumbs([("/", "Home"), ("/benchmarks/", "Benchmarks"), (None, "Leaderboard")]),
        "nfields": len(CATEGORY_ORDER), "minf": MIN_FIELDS,
        "leader": esc(leader["model"]["name"]) if leader else "no model",
        "nranked": len(entries), "total": len(MODELS), "ntop": len(top),
        "arrow": ICON_ARROW, "provenance": PROVENANCE,
        "overall": overall_table, "fields": "".join(blocks), "faq": faq_html,
    }

    page_id = url + "#webpage"
    ld = {"@context": "https://schema.org", "@graph": [
        {"@type": "CollectionPage", "@id": page_id, "url": url,
         "name": "AI model leaderboard — top models in every field",
         "description": "AI models ranked across reasoning, maths, coding, knowledge, multimodal, "
                        "instruction following and human preference, from published benchmark "
                        "figures.",
         "isPartOf": {"@id": SITE + "/#website"}, "inLanguage": "en",
         "dateModified": UPDATED, "breadcrumb": {"@id": page_id + "#breadcrumb"},
         "mainEntity": {"@id": url + "#list"}},
        crumb_ld([("/", "Home"), ("/benchmarks/", "Benchmarks"), (None, "Leaderboard")], page_id),
        {"@type": "ItemList", "@id": url + "#list",
         "name": "Top AI models across every capability field",
         "numberOfItems": len(top),
         "itemListOrder": "https://schema.org/ItemListOrderDescending",
         "itemListElement": [
             {"@type": "ListItem", "position": i,
              "item": {"@type": "SoftwareApplication", "name": e["model"]["name"],
                       "url": SITE + model_url(e["model"]["slug"])}}
             for i, e in enumerate(top, start=1)]},
        {"@type": "FAQPage", "@id": url + "#faq", "mainEntity": [
            {"@type": "Question", "name": q,
             "acceptedAnswer": {"@type": "Answer", "text": a}} for q, a in faqs]},
    ]}

    write("/benchmarks/leaderboard/", page(
        "AI Model Leaderboard — Top Models in Every Field",
        "Which AI models lead at reasoning, maths, coding, knowledge, multimodal, instruction "
        "following and human preference. Ranked from published benchmark figures across %d models "
        "from %d labs." % (len(MODELS), len(COMPANIES)),
        url, body, jsonld=ld))


# ===========================================================================
# Benchmark (test) pages
# ===========================================================================
def build_test(b):
    key = b["key"]
    url = SITE + test_url(key)
    ranked = sorted(((m, m["b"][key]) for m in MODELS if m.get("b", {}).get(key) is not None),
                    key=lambda t: -t[1])
    top = ranked[:20]

    rows = "".join(
        '<tr><td class="bm-num" style="width:56px;color:var(--faint)">%d</td>'
        '<td><span class="bm-model-cell">%s<span class="names">'
        '<a class="name" href="%s">%s</a><span class="maker">%s</span></span></span></td>'
        '<td style="min-width:190px">%s</td></tr>'
        % (i, logo_tile(m["company"], "", 19, "is-sm"), model_url(m["slug"]),
           esc(m["name"]), esc(COMPANIES[m["company"]]["name"]),
           bench_cell(key, v, i == 1))
        for i, (m, v) in enumerate(top, start=1))

    body = """
  <div class="shell page-head">
    %(crumbs)s
    <p class="eyebrow" style="margin-bottom:18px">%(group)s</p>
    <h1>%(name)s</h1>
    <p class="lede">%(blurb)s</p>
    <div class="answer-box">
      <p><strong>%(name)s</strong> is %(lower)s %(reported)d of the %(total)d models in this
        index report a score for it. The highest published figure here is
        <strong>%(bestv)s</strong>, from %(bestm)s.</p>
    </div>
    <div class="btn-row" style="margin-top:22px">
      <a class="btn btn-ghost" href="%(url)s" rel="noopener" target="_blank">The benchmark itself %(ext)s</a>
      <a class="btn btn-ghost" href="/benchmarks/">All models %(arrow)s</a>
    </div>
  </div>

  <div class="shell"><hr class="rule"></div>

  <section class="section-tight" aria-labelledby="rank-title">
    <div class="shell">
      <div class="section-head" style="margin-bottom:22px">
        <p class="eyebrow">Reported scores</p>
        <h2 id="rank-title">Top %(ntop)d on %(name)s</h2>
        <p>Ordered by the figure each maker published. Models that have not reported this
          benchmark are not listed — an absent score is not a low score.</p>
      </div>
      <div class="bm-table-wrap">
        <table class="bm-table" style="min-width:520px">
          <caption class="visually-hidden">Models ranked by published %(name)s score</caption>
          <thead><tr><th class="bm-num" scope="col">#</th><th scope="col">Model</th>
            <th scope="col">Published score</th></tr></thead>
          <tbody>%(rows)s</tbody>
        </table>
      </div>
      <div style="margin-top:24px">%(provenance)s</div>
    </div>
  </section>

  <section class="section-tight">
    <div class="shell">
      <div class="doc-layout"><div></div><div class="prose">
        <h2 style="font-family:var(--serif)">How to read this score</h2>
        <p>%(howto)s</p>
        <h3>Where it is weak</h3>
        <p>%(weak)s</p>
      </div></div>
    </div>
  </section>
""" % {
        "crumbs": crumbs([("/", "Home"), ("/benchmarks/", "Benchmarks"),
                          ("/benchmarks/#tests", "Tests"), (None, b["name"])]),
        "group": esc(b["group"]), "name": esc(b["name"]), "blurb": esc(b["blurb"]),
        "lower": ("a rating, not a percentage" if b["unit"] == "elo"
                  else "scored as a percentage of questions answered correctly."),
        "reported": len(ranked), "total": len(MODELS),
        "bestv": esc(fmt_score(key, top[0][1])) if top else "—",
        "bestm": esc(top[0][0]["name"]) if top else "—",
        "url": esc(b["url"]), "ext": ICON_EXTERNAL, "arrow": ICON_ARROW,
        "ntop": len(top), "rows": rows, "provenance": PROVENANCE,
        "howto": TEST_NOTES[key][0], "weak": TEST_NOTES[key][1],
    }

    page_id = url + "#webpage"
    ld = {"@context": "https://schema.org", "@graph": [
        {"@type": "WebPage", "@id": page_id, "url": url,
         "name": "%s — what it measures and which models lead" % b["name"],
         "isPartOf": {"@id": SITE + "/#website"}, "inLanguage": "en",
         "dateModified": UPDATED, "breadcrumb": {"@id": page_id + "#breadcrumb"},
         "mainEntity": {"@id": url + "#term"}},
        crumb_ld([("/", "Home"), ("/benchmarks/", "Benchmarks"), (None, b["name"])], page_id),
        {"@type": "DefinedTerm", "@id": url + "#term", "name": b["name"],
         "description": b["blurb"], "url": url,
         "inDefinedTermSet": {"@type": "DefinedTermSet",
                              "name": "AI model evaluation benchmarks"}},
    ]}

    write(test_url(key), page(
        "%s — What It Measures and Which AI Models Lead" % b["name"],
        "%s %s Published scores for %d models, ranked, with what the benchmark does and "
        "does not tell you." % (b["name"] + ":", b["blurb"], len(ranked)),
        url, body, jsonld=ld))


TEST_NOTES = {
    "mmlu_pro": (
        "A high MMLU-Pro score means the model carries a lot of factual knowledge and can "
        "reason over it under multiple-choice conditions. The ten-option format makes lucky "
        "guessing worth 10% rather than 25%, so the spread between models is wider and more "
        "meaningful than on the original MMLU.",
        "It is still multiple choice, which is nothing like the open-ended work most people "
        "give a model. A model can pick the right option and still be unable to explain it, "
        "and the format rewards recall over judgement."),
    "gpqa": (
        "GPQA Diamond is the closest thing to a pure reasoning test in common use. The "
        "questions were written by domain PhDs specifically so that a non-expert with "
        "unlimited web access still scores around 34%, which means a high score cannot come "
        "from retrieval alone.",
        "There are only 198 questions, so a few lucky answers move the number by a full "
        "point. It also covers three sciences and nothing else — it says little about "
        "writing, code or judgement."),
    "aime": (
        "AIME problems have a single integer answer and no partial credit, so the score is "
        "unambiguous. It is the standard proxy for multi-step symbolic reasoning, and the "
        "benchmark where reasoning models separated themselves most sharply from the rest.",
        "Fifteen problems a year makes for a very small sample, and labs often report the "
        "average of many attempts rather than a single pass, which is not the same thing. "
        "Competition maths also has little in common with the arithmetic in ordinary work."),
    "math": (
        "MATH-500 is broader and easier than AIME, covering algebra, geometry, number theory "
        "and precalculus. It is useful for separating mid-tier models that all score near "
        "zero on AIME.",
        "The frontier has saturated it — several models sit above 97%, where the remaining "
        "difference is mostly grading noise rather than capability."),
    "swe": (
        "SWE-bench Verified is the most decision-relevant benchmark here for anyone using a "
        "model to write code. Each task is a real GitHub issue, and the patch has to make "
        "the project's own test suite pass — there is no partial credit and no judge model.",
        "It measures an entire agent, not a model. Retrieval, retries and test execution are "
        "all part of the harness, and two labs reporting the same number may be running very "
        "different scaffolds. It is also Python-only, on twelve repositories."),
    "lcb": (
        "LiveCodeBench collects competitive-programming problems published after each "
        "model's training cutoff, so a high score cannot come from having memorised the "
        "answer. That makes it the most contamination-resistant coding number in this index.",
        "Competitive programming is a narrow slice of software work — tight, self-contained, "
        "heavily algorithmic. It predicts very little about maintaining a large codebase."),
    "humaneval": (
        "HumanEval is included for continuity with older models rather than for its "
        "discriminating power. It is 164 short functions written from a docstring.",
        "Saturated and contaminated. Frontier models cluster above 90%, and the problems have "
        "been in training data for years. Treat any difference under about five points as "
        "meaningless."),
    "mmmu": (
        "MMMU is the standard test of whether a model can genuinely read an image rather "
        "than caption it — the questions require pulling values off a chart, reading a "
        "circuit diagram, or interpreting a medical scan alongside the text.",
        "Human experts score around 88%, so there is real headroom, but many questions can "
        "be narrowed down from the text alone. Reported scores also vary with how the image "
        "was encoded and at what resolution."),
    "ifeval": (
        "IFEval checks instructions a program can verify — write under 200 words, answer in "
        "JSON, never use the letter e. Because a script grades it rather than a judge model, "
        "the score is unusually reproducible.",
        "Following a format is not the same as following intent. A model can score highly "
        "here and still miss what was actually being asked for."),
    "arena": (
        "LMArena Elo comes from blind pairwise votes by the public, so it captures something "
        "no static benchmark can: whether people prefer the answer. It cannot be gamed by "
        "training on a test set, because there is no fixed test set.",
        "It measures preference, not correctness. Length, formatting and confident tone all "
        "reliably win votes, and voters are self-selected rather than representative. A model "
        "can climb by being agreeable rather than by being right."),
}


# ===========================================================================
# Company pages
# ===========================================================================
def model_product_cards(models):
    """Models as things that were made, rather than rows of scores.

    Used on the CorX Labs page, where a benchmark table is the wrong shape:
    every score column would be empty, which reads as a bad result instead of
    an absent one.
    """
    cards = []
    for m in models:
        facts = [
            ("Parameters", params_label(m)),
            ("Type", m.get("kind", "Language model")),
            ("Architecture", arch_label(m)),
            ("Context", ("%s tokens" % format(m["ctx"], ",")) if m.get("ctx") else None),
            ("Input", modality_label(m.get("inp"))),
            ("Output", modality_label(m.get("outp"))),
            ("Licence", licence_of(m)),
            ("Weights", "Downloadable" if is_open(m) else "Not released"),
        ]
        facts_html = "".join(
            '<div><dt>%s</dt><dd%s>%s</dd></div>'
            % (esc(label), "" if value else ' class="is-nil"', nil(value))
            for label, value in facts if value or label in ("Parameters", "Type"))

        links = ['<a class="btn btn-primary btn-sm" href="%s">Model card %s</a>'
                 % (m["local"], ICON_ARROW)] if m.get("local") else []
        links.append('<a class="btn btn-ghost btn-sm" href="%s">Index entry %s</a>'
                     % (model_url(m["slug"]), ICON_ARROW))
        if m.get("hf"):
            links.append('<a class="btn btn-ghost btn-sm" href="https://huggingface.co/%s" '
                         'rel="noopener" target="_blank">Hugging Face %s</a>'
                         % (esc(m["hf"]), ICON_EXTERNAL))

        cards.append(
            '<article class="card model-card"><div>%s<h3 style="margin-top:14px">%s</h3>'
            '<p class="lede" style="margin-top:12px">%s</p></div>'
            '<dl class="bm-keyfacts">%s</dl>'
            '<div class="btn-row">%s</div></article>'
            % (tag_row(m), esc(m["name"]), esc(m.get("desc", "")), facts_html, "".join(links)))
    return "".join(cards)


def build_corx_company(cid, meta):
    """CorX Labs gets its own shape. It is the lab whose site this is, its
    models have no published scores, and a table of empty score columns would
    be both useless and misleading."""
    url = SITE + company_url(cid)
    models = sorted((m for m in MODELS if m["company"] == cid),
                    key=lambda m: m.get("rel") or "", reverse=True)

    body = """
  <div class="shell page-head">
    %(crumbs)s
    <div class="bm-model-head">
      %(logo)s
      <div>
        <h1>%(name)s</h1>
        <span class="maker">%(country)s &middot; <a href="/">corx-labs.com</a></span>
      </div>
    </div>
    <div class="answer-box">
      <p><strong>CorX Labs</strong> is an independent AI research lab in Jamaica, and the lab that
        publishes this index. It has released %(n)d models, all with open weights: a 27B Jamaican
        Patois assistant, a singing voice synthesis model, and a small language model trained from
        random weights. All %(n)d are listed below.</p>
    </div>
  </div>

  <div class="shell"><hr class="rule"></div>

  <section class="section-tight" aria-labelledby="made-title">
    <div class="shell">
      <div class="section-head" style="margin-bottom:26px">
        <p class="eyebrow">Released</p>
        <h2 id="made-title">The models we made</h2>
        <p>Each one, what it is and what it is built from. Full model cards live in
          <a href="/models/" style="text-decoration:underline;text-underline-offset:3px">Our
          Products</a>.</p>
      </div>
      %(cards)s
    </div>
  </section>

  <section class="section-tight" aria-labelledby="scores-title">
    <div class="shell">
      <div class="section-head" style="margin-bottom:22px">
        <p class="eyebrow">Benchmarks</p>
        <h2 id="scores-title">Why there are no scores here</h2>
      </div>
      <div class="bm-provenance">
        %(info)s
        <div>
          <h3>CorX Labs has not published benchmark figures</h3>
          <p>Every other lab in this index is listed with the numbers it published. CorX Labs has
            not run these evaluations on its own models, so it has no numbers to list — and it is
            not going to quote Qwen3.8-27B's scores as CorX3.8-27B's, estimate from model size, or
            put a figure in a column it did not measure. An index that made an exception for the
            lab that runs it would be worth nothing.</p>
          <p>The specification rows are real and comparable, so the models can still be put
            side by side with anything else here on parameters, context, modalities, licence and
            cost. When the evaluations are run, the scores go in like everyone else's.</p>
        </div>
      </div>
      <div class="btn-row" style="margin-top:22px">
        <a class="btn btn-primary" href="/benchmarks/compare/?m=%(slugs)s">Compare our models %(arrow)s</a>
        <a class="btn btn-ghost" href="/benchmarks/">All %(total)d models in the index</a>
        <a class="btn btn-ghost" href="/models/">Our Products %(arrow)s</a>
      </div>
    </div>
  </section>

  <section class="section-tight" aria-labelledby="spec-title">
    <div class="shell">
      <div class="section-head" style="margin-bottom:22px">
        <p class="eyebrow">In the index</p>
        <h2 id="spec-title">How they sit in the table</h2>
        <p>The same row every other model gets, so nothing about ours is presented differently.</p>
      </div>
      %(table)s
    </div>
  </section>
""" % {
        "crumbs": crumbs([("/", "Home"), ("/benchmarks/", "Benchmarks"),
                          ("/benchmarks/#companies", "Makers"), (None, meta["name"])]),
        "logo": logo_tile(cid, meta["name"], 34, "is-lg", lazy=False),
        "name": esc(meta["name"]), "country": esc(meta["country"]),
        "n": len(models), "cards": model_product_cards(models),
        "info": ICON_INFO, "arrow": ICON_ARROW, "total": len(MODELS),
        "slugs": esc(",".join(m["slug"] for m in models)),
        "table": leaderboard_table(models, checkbox=False, table_id="bm-company-models"),
    }

    page_id = url + "#webpage"
    ld = {"@context": "https://schema.org", "@graph": [
        {"@type": "CollectionPage", "@id": page_id, "url": url,
         "name": "CorX Labs models — every model built by the lab",
         "isPartOf": {"@id": SITE + "/#website"}, "inLanguage": "en",
         "dateModified": UPDATED, "breadcrumb": {"@id": page_id + "#breadcrumb"},
         "about": {"@id": SITE + "/#organization"}},
        crumb_ld([("/", "Home"), ("/benchmarks/", "Benchmarks"), (None, meta["name"])], page_id),
        {"@type": "ItemList", "@id": url + "#list", "numberOfItems": len(models),
         "itemListElement": [
             {"@type": "ListItem", "position": i,
              "item": {"@type": "SoftwareApplication", "name": m["name"],
                       "url": SITE + (m.get("local") or model_url(m["slug"])),
                       "description": m.get("desc", "")}}
             for i, m in enumerate(models, start=1)]},
    ]}

    write(company_url(cid), page(
        "CorX Labs Models — Every Model Built by the Lab",
        "Every model CorX Labs has released: %s. Parameters, architecture, licence and where to "
        "download each one." % ", ".join(m["name"] for m in models),
        url, body, jsonld=ld, og_image="og-models.jpg"))


def build_company(cid, meta):
    if cid == "corx":
        return build_corx_company(cid, meta)
    url = SITE + company_url(cid)
    models = sorted((m for m in MODELS if m["company"] == cid),
                    key=lambda m: m.get("rel") or "", reverse=True)
    n_open = sum(1 for m in models if is_open(m))

    body = """
  <div class="shell page-head">
    %(crumbs)s
    <div class="bm-model-head">
      %(logo)s
      <div>
        <h1>%(name)s</h1>
        <span class="maker">%(country)s &middot; <a href="https://%(site)s" rel="noopener"
          target="_blank">%(site)s</a></span>
      </div>
    </div>
    <div class="answer-box">
      <p><strong>%(name)s</strong> has %(n)d model%(s)s in the CorX Labs benchmark index,
        %(open_txt)s. Below: context window, price per million tokens, licence and published
        benchmark scores for each.</p>
    </div>
  </div>

  <div class="shell"><hr class="rule"></div>

  <section class="section-tight">
    <div class="shell">
      %(table)s
      <div style="margin-top:24px">%(provenance)s</div>
      <div class="btn-row" style="margin-top:22px">
        <a class="btn btn-ghost" href="/benchmarks/">All %(total)d models %(arrow)s</a>
        <a class="btn btn-ghost" href="/benchmarks/compare/">Compare models %(arrow)s</a>
      </div>
    </div>
  </section>
""" % {
        "crumbs": crumbs([("/", "Home"), ("/benchmarks/", "Benchmarks"),
                          ("/benchmarks/#companies", "Makers"), (None, meta["name"])]),
        "logo": logo_tile(cid, meta["name"], 34, "is-lg", lazy=False),
        "name": esc(meta["name"]), "country": esc(meta["country"]), "site": esc(meta["site"]),
        "n": len(models), "s": "" if len(models) == 1 else "s",
        "open_txt": ("all of them with open weights" if n_open == len(models)
                     else "none of them with open weights" if n_open == 0
                     else "%d of them with open weights" % n_open),
        "table": leaderboard_table(models, checkbox=False, table_id="bm-company-models"),
        "provenance": PROVENANCE, "total": len(MODELS), "arrow": ICON_ARROW,
    }

    page_id = url + "#webpage"
    ld = {"@context": "https://schema.org", "@graph": [
        {"@type": "CollectionPage", "@id": page_id, "url": url,
         "name": "%s AI models — specs, pricing and benchmarks" % meta["name"],
         "isPartOf": {"@id": SITE + "/#website"}, "inLanguage": "en",
         "dateModified": UPDATED, "breadcrumb": {"@id": page_id + "#breadcrumb"}},
        crumb_ld([("/", "Home"), ("/benchmarks/", "Benchmarks"), (None, meta["name"])], page_id),
        {"@type": "ItemList", "@id": url + "#list", "numberOfItems": len(models),
         "itemListElement": [
             {"@type": "ListItem", "position": i,
              "item": {"@type": "SoftwareApplication", "name": m["name"],
                       "url": SITE + model_url(m["slug"])}}
             for i, m in enumerate(models, start=1)]},
    ]}

    write(company_url(cid), page(
        "%s AI Models — Specs, Pricing and Benchmarks" % meta["name"],
        "Every %s model in the CorX Labs index: %s. Context window, price per million "
        "tokens, licence and published benchmark scores."
        % (meta["name"], ", ".join(m["name"] for m in models[:6])),
        url, body, jsonld=ld))


# ===========================================================================
# Data export for the compare tool
# ===========================================================================
def export_json():
    from logos import MANIFEST
    payload = {
        "updated": UPDATED,
        "site": SITE,
        "companies": {cid: {"name": meta["name"], "country": meta["country"],
                            "site": meta["site"], "logo": "/assets/img/logos/%s.svg" % cid,
                            "url": company_url(cid)}
                      for cid, meta in COMPANIES.items()},
        "benchmarks": [{"key": b["key"], "name": b["name"], "unit": b["unit"],
                        "group": b["group"], "blurb": b["blurb"], "url": test_url(b["key"])}
                       for b in BENCHMARKS],
        # So the tool can point at the dedicated static page when a pair has one.
        "pairs": {"%s|%s" % (a, b): compare_url(a, b) for a, b in COMPARISONS},
        "models": [],
    }
    for m in MODELS:
        row = {k: v for k, v in m.items() if v is not None}
        row["url"] = model_url(m["slug"])
        row["licence"] = licence_of(m)
        row["blended"] = blended_cost(m)
        payload["models"].append(row)

    out = os.path.join(ROOT, "assets", "data", "models.json")
    os.makedirs(os.path.dirname(out), exist_ok=True)
    with open(out, "w", encoding="utf-8") as f:
        json.dump(payload, f, separators=(",", ":"), ensure_ascii=False)
    return out, os.path.getsize(out)


# ===========================================================================
# Sitemap fragment
# ===========================================================================
def sitemap_urls():
    urls = [("/benchmarks/", "0.9", "weekly"),
            ("/benchmarks/leaderboard/", "0.9", "weekly"),
            ("/benchmarks/compare/", "0.8", "weekly")]
    urls += [(test_url(b["key"]), "0.6", "monthly") for b in BENCHMARKS]
    urls += [(company_url(c), "0.6", "monthly") for c in COMPANIES]
    urls += [(model_url(m["slug"]), "0.7", "monthly") for m in MODELS]
    urls += [(compare_url(a, b), "0.7", "monthly") for a, b in COMPARISONS]
    return urls


def write_sitemap_fragment():
    parts = []
    for loc, priority, freq in sitemap_urls():
        parts.append("""  <url>
    <loc>%s%s</loc>
    <lastmod>%s</lastmod>
    <changefreq>%s</changefreq>
    <priority>%s</priority>
    <xhtml:link rel="alternate" hreflang="en" href="%s%s"/>
    <xhtml:link rel="alternate" hreflang="x-default" href="%s%s"/>
  </url>""" % (SITE, loc, UPDATED, freq, priority, SITE, loc, SITE, loc))
    frag = "\n".join(parts)
    path = os.path.join(ROOT, "tools", "sitemap-benchmarks.xml")
    with open(path, "w", encoding="utf-8") as f:
        f.write(frag + "\n")
    return frag


# ===========================================================================
def main():
    validate()

    # A stale page for a model that has been removed would keep ranking and
    # keep 200-ing, so the tree is rebuilt from scratch every time.
    for sub in ("models", "compare", "tests", "companies"):
        shutil.rmtree(os.path.join(OUT, sub), ignore_errors=True)

    build_hub()
    build_compare_tool()
    build_leaderboard()
    for m in MODELS:
        build_model(m)
    for a, b in COMPARISONS:
        build_comparison(a, b)
    for b in BENCHMARKS:
        build_test(b)
    for cid, meta in COMPANIES.items():
        build_company(cid, meta)

    json_path, json_size = export_json()
    write_sitemap_fragment()

    pages = 3 + len(MODELS) + len(COMPARISONS) + len(BENCHMARKS) + len(COMPANIES)
    print("Built %d pages:" % pages)
    print("  1   hub                /benchmarks/")
    print("  1   leaderboard        /benchmarks/leaderboard/")
    print("  1   compare tool       /benchmarks/compare/")
    print("  %-3d model pages       /benchmarks/models/<slug>/" % len(MODELS))
    print("  %-3d head-to-heads     /benchmarks/compare/<a>-vs-<b>/" % len(COMPARISONS))
    print("  %-3d benchmark pages   /benchmarks/tests/<key>/" % len(BENCHMARKS))
    print("  %-3d company pages     /benchmarks/companies/<id>/" % len(COMPANIES))
    print("  data  %s (%.1f KB)" % (os.path.relpath(json_path, ROOT), json_size / 1024))
    print("  sitemap fragment      tools/sitemap-benchmarks.xml (%d urls)" % len(sitemap_urls()))


if __name__ == "__main__":
    main()
