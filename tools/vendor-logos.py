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

# CorX Labs' own mark: the old-style serif C from the site's logo, drawn as a
# path so it renders identically without loading a webfont.
CORX_SVG = (
    '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" fill="currentColor">'
    '<path d="M12 1.4C6.15 1.4 1.4 6.15 1.4 12S6.15 22.6 12 22.6 22.6 17.85 22.6 12 17.85 1.4 12 1.4Z'
    'm0 1.35a9.25 9.25 0 1 1 0 18.5 9.25 9.25 0 0 1 0-18.5Z" opacity=".35"/>'
    '<path d="M16.3 8.06a4.02 4.02 0 0 0-3.2-1.5c-2.53 0-4.28 2.2-4.28 5.36 0 3.3 1.73 5.52 4.3 5.52'
    'a4.1 4.1 0 0 0 3.32-1.66l.63.5c-.98 1.42-2.5 2.24-4.28 2.24-3.4 0-5.85-2.7-5.85-6.5'
    'C6.94 8.2 9.4 5.5 12.8 5.5c1.2 0 2.28.32 3.16.9l.28-.76h.6l.1 3.5h-.6a5.6 5.6 0 0 0-.04-1.08Z"/>'
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
    manifest = {}

    def write(cid, view_box, body):
        with open(os.path.join(OUT_DIR, cid + ".svg"), "w") as f:
            f.write('<svg xmlns="http://www.w3.org/2000/svg" viewBox="%s">%s</svg>'
                    % (view_box, body))

    for cid in COMPANIES:
        if cid == "corx":
            view_box, body = clean(CORX_SVG, cid)
            write(cid, view_box, INK_STYLE + to_ink(body))
            manifest[cid] = {"viewBox": view_box, "mono": True, "source": "CorX Labs"}
            continue

        if cid not in SOURCES:
            text = MONOGRAMS.get(cid, COMPANIES[cid]["name"][:2].capitalize())
            write(cid, "0 0 24 24", monogram_svg(text))
            manifest[cid] = {"viewBox": "0 0 24 24", "mono": True,
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
        write(cid, view_box, out)
        manifest[cid] = {"viewBox": view_box, "mono": mono, "source": src, "icon": name,
                         "mixed": (not mono) and "currentColor" in body}

    with open(os.path.join(OUT_DIR, "manifest.json"), "w") as f:
        json.dump(manifest, f, indent=1, sort_keys=True)

    real = [v for v in manifest.values() if v.get("source") not in ("monogram",)]
    mono = sum(1 for v in real if v["mono"])
    print("%d real logos vendored (%d ink, %d full colour), %d monogram tiles"
          % (len(real), mono, len(real) - mono, len(manifest) - len(real)))


if __name__ == "__main__":
    main()
