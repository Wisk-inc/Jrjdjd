#!/usr/bin/env python3
"""
Company marks for /benchmarks/.

The SVGs themselves live in assets/img/logos/ and are vendored by
tools/vendor-logos.py from two permissively-licensed sets — @lobehub's AI
provider icons (MIT) and simple-icons (CC0). They are the labs' real marks,
not redrawings.

They are referenced as plain <img> rather than inlined, which matters at this
scale: the catalogue renders across 200-odd static pages, and inlining a 6KB
mark into every one of them would cost more than the whole rest of the HTML.
As separate files they are fetched once and cached across the entire section.

Dark mode is handled inside each file. An <img> renders its SVG in a separate
document where `currentColor` means the *image's* colour, so a monochrome mark
would paint black on black; the vendored monochrome files therefore carry their
own prefers-color-scheme stylesheet. Full-colour marks are left untouched.
"""

import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
LOGO_DIR = os.path.join(ROOT, "assets", "img", "logos")
LOGO_URL = "/assets/img/logos/%s.svg"

with open(os.path.join(LOGO_DIR, "manifest.json")) as _f:
    MANIFEST = json.load(_f)


def logo_url(company_id):
    return LOGO_URL % company_id


def has_real_mark(company_id):
    return MANIFEST.get(company_id, {}).get("source") not in (None, "monogram")


def mark_img(company_id, company_name, size=24, extra_class="", lazy=True):
    """One company mark, ready to drop into a page."""
    cls = ("logo-mark " + extra_class).strip()
    return (
        '<img class="%s" src="%s" width="%d" height="%d" alt="" aria-hidden="true"'
        '%s decoding="async">'
        % (cls, logo_url(company_id), size, size, ' loading="lazy"' if lazy else "")
    )


def mark_figure(company_id, company_name, size=24, extra_class="", lazy=True):
    """A mark that carries the company name for assistive technology."""
    cls = ("logo-mark " + extra_class).strip()
    return (
        '<img class="%s" src="%s" width="%d" height="%d" alt="%s logo"%s decoding="async">'
        % (cls, logo_url(company_id), size, size, company_name,
           ' loading="lazy"' if lazy else "")
    )


def attribution():
    """Sources, for the credit line the section carries."""
    used = {v.get("source") for v in MANIFEST.values()}
    used.discard("monogram")
    used.discard(None)
    return sorted(used)


if __name__ == "__main__":
    import sys
    sys.path.insert(0, HERE)
    from model_catalog import COMPANIES
    missing = [c for c in COMPANIES if c not in MANIFEST]
    if missing:
        raise SystemExit("no logo for: " + ", ".join(missing))
    real = [c for c in COMPANIES if has_real_mark(c)]
    print("%d/%d companies have their real mark; sources: %s"
          % (len(real), len(COMPANIES), "; ".join(attribution())))
