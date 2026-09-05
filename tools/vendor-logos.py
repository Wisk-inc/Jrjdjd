#!/usr/bin/env python3
"""
Vendor real company logos into assets/img/logos/.

Sources, both permissively licensed and both redistributable:

  * @lobehub/icons-static-svg (MIT) — an icon set built specifically for AI
    model providers, which is why it covers labs like DeepSeek, Moonshot,
    Zhipu and StepFun that general icon sets miss.
  * simple-icons (CC0-1.0) — fills the remaining gaps.

Trademarks stay with their owners. These are used to identify each lab's own
models on a comparison page, which is nominative use; the site claims no
affiliation and says so on the page.

Run:  python3 tools/vendor-logos.py [--pkg <extracted lobehub package dir>]

The logos are committed to the repo, so this only needs re-running when a
company is added or a mark changes. It requires network access; the generator
does not.
"""

import argparse
import hashlib
import json
import os
import re
import sys
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
OUT_DIR = os.path.join(ROOT, "assets", "img", "logos")

SI_RAW = "https://raw.githubusercontent.com/simple-icons/simple-icons/develop/icons/%s.svg"

# company id -> (source, name). "lobe" reads from the extracted package,
# "si" fetches from simple-icons. Anything absent gets a monogram tile.
SOURCES = {
    "openai":     ("lobe", "openai"),
    "anthropic":  ("lobe", "claude-color"),
    "google":     ("lobe", "gemini-color"),
    "meta":       ("lobe", "meta-color"),
    "mistral":    ("lobe", "mistral-color"),
    "deepseek":   ("lobe", "deepseek-color"),
    "alibaba":    ("lobe", "qwen-color"),
    "xai":        ("lobe", "xai"),
    "amazon":     ("lobe", "aws-color"),
    "microsoft":  ("lobe", "microsoft-color"),
    "cohere":     ("lobe", "cohere-color"),
    "ai21":       ("lobe", "ai21"),
    "moonshot":   ("lobe", "moonshot"),
    "zai":        ("lobe", "zhipu-color"),
    "minimax":    ("lobe", "minimax-color"),
    "nvidia":     ("lobe", "nvidia-color"),
    "allenai":    ("lobe", "ai2-color"),
    "01ai":       ("lobe", "zeroone-color"),
    "liquid":     ("lobe", "liquid"),
    "perplexity": ("lobe", "perplexity-color"),
    "baidu":      ("lobe", "baidu-color"),
    "tencent":    ("lobe", "hunyuan-color"),
    "bytedance":  ("lobe", "bytedance-color"),
    "stepfun":    ("lobe", "stepfun-color"),
    "ibm":        ("lobe", "ibm"),
    "nous":       ("lobe", "nousresearch"),
    "upstage":    ("lobe", "upstage-color"),
    "inception":  ("lobe", "inception"),
    "tii":        ("lobe", "tii-color"),
    "snowflake":  ("lobe", "snowflake-color"),
    "lgai":       ("lobe", "lg-color"),
    "inclusion":  ("lobe", "antgroup-color"),
    "apple":      ("lobe", "apple"),
    "databricks": ("si",   "databricks"),
    "naver":      ("si",   "naver"),
    "rednote":    ("si",   "xiaohongshu"),
}

# CorX Labs' own mark: the Cormorant Garamond capital C from assets/img/logo.png,
# extracted from the same font, then optically sized (weight 700, cap 0.86) so it
# holds its own beside the other marks at 19-22px, where Cormorant's hairlines at
# the CSS weight of 500 all but disappear.
# Regenerate with tools/extract-corx-mark.py if the brand letterform changes.
CORX_PATH = "M14.675555555555556 1.6799999999999997Q15.631111111111112 1.6799999999999997 16.6662962962963 1.775555555555556Q17.701481481481483 1.8711111111111123 18.625185185185188 2.062222222222223Q19.54888888888889 2.253333333333334 20.185925925925925 2.539999999999999Q20.472592592592594 2.6355555555555554 20.552222222222223 2.778888888888888Q20.631851851851852 2.9222222222222207 20.663703703703703 3.2725925925925914L21.07777777777778 7.700000000000001Q21.07777777777778 7.795555555555556 20.918518518518518 7.827407407407407Q20.75925925925926 7.859259259259259 20.695555555555558 7.731851851851852Q19.803703703703704 5.151851851851852 18.163333333333334 3.750370370370371Q16.522962962962964 2.34888888888889 14.165925925925926 2.34888888888889Q12.0 2.34888888888889 10.295925925925927 3.511481481481482Q8.591851851851853 4.674074074074074 7.620370370370371 6.808148148148148Q6.648888888888889 8.942222222222222 6.648888888888889 11.904444444444445Q6.648888888888889 14.134074074074075 7.222222222222222 15.933703703703705Q7.795555555555556 17.733333333333334 8.846666666666668 19.007407407407406Q9.897777777777778 20.28148148148148 11.331111111111111 20.9662962962963Q12.764444444444445 21.651111111111113 14.484444444444446 21.651111111111113Q16.745925925925924 21.651111111111113 18.227037037037036 20.424814814814816Q19.708148148148148 19.19851851851852 21.014074074074074 16.522962962962964Q21.07777777777778 16.427407407407408 21.221111111111114 16.45925925925926Q21.364444444444445 16.49111111111111 21.364444444444445 16.586666666666666L20.886666666666667 20.536296296296296Q20.854814814814816 20.918518518518518 20.775185185185187 21.03Q20.695555555555558 21.14148148148148 20.40888888888889 21.26888888888889Q18.88 21.81037037037037 17.367037037037036 22.065185185185186Q15.854074074074074 22.32 14.484444444444446 22.32Q11.044444444444444 22.32 8.36888888888889 21.03Q5.693333333333333 19.740000000000002 4.164444444444444 17.43074074074074Q2.6355555555555554 15.121481481481482 2.6355555555555554 12.127407407407407Q2.6355555555555554 9.834074074074074 3.543333333333333 7.907037037037037Q4.451111111111111 5.98 6.091481481481481 4.594444444444445Q7.731851851851852 3.2088888888888896 9.92962962962963 2.4444444444444446Q12.127407407407407 1.6799999999999997 14.675555555555556 1.6799999999999997Z"

# No fill anywhere: a fill on the path (or carried onto a wrapping <g>) is a
# presentation attribute on the element itself and would beat the inherited
# value from the file's own dark-mode stylesheet, pinning the mark to espresso
# on a dark background.
CORX_SVG = (
    '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">'
    '<path d="' + CORX_PATH + '"/>'
    '</svg>'
)

MONOGRAMS = {"reka": "Rk", "salesforce": "SF", "writer": "Wr", "sarvam": "Sv", "openbmb": "BM"}


def clean(svg, name):
    """Normalise an upstream SVG down to a viewBox and its drawing children."""
    svg = re.sub(r"<\?xml.*?\?>", "", svg, flags=re.S)
    svg = re.sub(r"<!--.*?-->", "", svg, flags=re.S)
    svg = re.sub(r"<title>.*?</title>", "", svg, flags=re.S)
    svg = re.sub(r"<desc>.*?</desc>", "", svg, flags=re.S)

    open_tag = re.search(r"<svg\b[^>]*>", svg, flags=re.S)
    if not open_tag:
        raise ValueError("%s: no <svg> element" % name)
    attrs = open_tag.group(0)

    vb = re.search(r'viewBox="([^"]+)"', attrs)
    view_box = vb.group(1) if vb else "0 0 24 24"

    body = svg[open_tag.end():]
    body = body[:body.rindex("</svg>")].strip()

    # fill-rule / clip-rule set on the root have to move inward or the shape
    # renders as a solid blob once the root element is dropped.
    carry = ""
    for attr in ("fill-rule", "clip-rule", "fill"):
        m = re.search(r'\s%s="([^"]+)"' % attr, attrs)
        if m and not (attr == "fill" and m.group(1) == "none"):
            carry += ' %s="%s"' % (attr, m.group(1))
    if carry:
        body = "<g%s>%s</g>" % (carry, body)

    # simple-icons ship no fill at all and rely on the UA default of black,
    # which is invisible in dark mode. Make them follow the text colour.
    if "fill=" not in body and "currentColor" not in body:
        body = '<g fill="currentColor">%s</g>' % body

    return view_box, body


def monochrome(body):
    """True when the mark has no colour of its own and should take the ink."""
    fills = set(re.findall(r'fill="([^"]+)"', body))
    fills |= set(re.findall(r'stop-color="([^"]+)"', body))
    fills.discard("none")
    if not fills:
        return True
    neutral = {"currentColor", "#000", "#000000", "black", "#fff", "#ffffff", "white"}
    return all(f in neutral for f in fills)


# An <img> renders an SVG in its own document, so `currentColor` there resolves
# to the *image's* colour, not the page's — which paints a black mark on a black
# background in dark mode. A stylesheet inside the file fixes that: SVG-as-image
# still honours prefers-color-scheme, and the site themes on that query alone.
INK_STYLE = (
    "<style>svg{fill:#211a13}"
    "@media(prefers-color-scheme:dark){svg{fill:#f2eee6}}</style>"
)
NEUTRAL_FILLS = ("currentColor", "#000", "#000000", "black")

# Some full-colour marks are mixed: a brand-coloured symbol next to a wordmark
# left as `currentColor` (AWS and 01.AI both do this). Those parts would render
# black-on-black, so the file gets a `color` of its own to resolve them against.
MIXED_STYLE = (
    "<style>svg{color:#211a13}"
    "@media(prefers-color-scheme:dark){svg{color:#f2eee6}}</style>"
)


def to_ink(body):
    """Strip a monochrome mark's own fills so the stylesheet above governs it."""
    for value in NEUTRAL_FILLS:
        body = body.replace(' fill="%s"' % value, "")
        body = body.replace(' stroke="%s"' % value, ' stroke="inherit"')
    # A stroked mark needs the colour on `stroke`, which does not inherit from
    # `fill`; point it back at the element's own resolved fill.
    body = body.replace(' stroke="inherit"', ' style="stroke:currentColor"')
    return body


def monogram_svg(text):
    """Fallback tile for the handful of labs with no published mark available."""
    size = "9.6" if len(text) > 1 else "12.5"
    return (
        '<style>svg{fill:#211a13}.tile{opacity:.11}'
        '@media(prefers-color-scheme:dark){svg{fill:#f2eee6}.tile{opacity:.16}}</style>'
        '<rect class="tile" x="0.8" y="0.8" width="22.4" height="22.4" rx="6.4"/>'
        '<text x="12" y="16.2" text-anchor="middle" font-size="%s" font-weight="600" '
        'font-family="Inter,system-ui,-apple-system,Segoe UI,Roboto,sans-serif">%s</text>'
        % (size, text)
    )


def fetch(url):
    req = urllib.request.Request(url, headers={"User-Agent": "corx-labs-logo-vendor"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return r.read().decode("utf-8")


def main():
    sys.path.insert(0, HERE)
    from model_catalog import COMPANIES

    ap = argparse.ArgumentParser()
    ap.add_argument("--pkg", default=os.environ.get("LOBE_PKG", ""),
                    help="directory of the extracted @lobehub/icons-static-svg package")
    args = ap.parse_args()

    os.makedirs(OUT_DIR, exist_ok=True)
    # A logo at a stable path cannot be corrected once a browser has it: the
    # response is immutable for a year, so a fix reaches nobody who already
    # loaded the old one. Content-hashed filenames mean a changed mark is a
    # changed URL, which no cache has seen — and lets the files stay immutable,
    # which is what you actually want for an asset that never changes in place.
    for stale in os.listdir(OUT_DIR):
        if stale.endswith(".svg"):
            os.remove(os.path.join(OUT_DIR, stale))

    manifest = {}

    def write(cid, view_box, body):
        svg = ('<svg xmlns="http://www.w3.org/2000/svg" viewBox="%s">%s</svg>'
               % (view_box, body))
        digest = hashlib.sha1(svg.encode("utf-8")).hexdigest()[:8]
        name = "%s.%s.svg" % (cid, digest)
        with open(os.path.join(OUT_DIR, name), "w") as f:
            f.write(svg)
        return name

    for cid in COMPANIES:
        if cid == "corx":
            view_box, body = clean(CORX_SVG, cid)
            # Espresso on paper, matching the brand, rather than the generic ink
            # the other monochrome marks take.
            style = ("<style>svg{fill:#3d3025}"
                     "@media(prefers-color-scheme:dark){svg{fill:#d8c9b6}}</style>")
            name = write(cid, view_box, style + to_ink(body))
            manifest[cid] = {"file": name, "viewBox": view_box, "mono": True,
                             "source": "CorX Labs"}
            continue

        if cid not in SOURCES:
            text = MONOGRAMS.get(cid, COMPANIES[cid]["name"][:2].capitalize())
            name = write(cid, "0 0 24 24", monogram_svg(text))
            manifest[cid] = {"file": name, "viewBox": "0 0 24 24", "mono": True,
                             "monogram": text, "source": "monogram"}
            continue

        kind, name = SOURCES[cid]
        if kind == "lobe":
            path = os.path.join(args.pkg, "icons", name + ".svg")
            if not os.path.exists(path):
                raise SystemExit("missing source icon for %s: %s" % (cid, path))
            raw = open(path, encoding="utf-8").read()
            src = "@lobehub/icons-static-svg (MIT)"
        else:
            raw = fetch(SI_RAW % name)
            src = "simple-icons (CC0-1.0)"

        view_box, body = clean(raw, cid)
        mono = monochrome(body)
        if mono:
            out = INK_STYLE + to_ink(body)
        elif "currentColor" in body:
            out = MIXED_STYLE + body
        else:
            out = body
        out_name = write(cid, view_box, out)
        manifest[cid] = {"file": out_name, "viewBox": view_box, "mono": mono,
                         "source": src, "icon": name,
                         "mixed": (not mono) and "currentColor" in body}

    with open(os.path.join(OUT_DIR, "manifest.json"), "w") as f:
        json.dump(manifest, f, indent=1, sort_keys=True)

    real = [v for v in manifest.values() if v.get("source") not in ("monogram",)]
    mono = sum(1 for v in real if v["mono"])
    print("%d real logos vendored (%d ink, %d full colour), %d monogram tiles"
          % (len(real), mono, len(real) - mono, len(manifest) - len(real)))


if __name__ == "__main__":
    main()
