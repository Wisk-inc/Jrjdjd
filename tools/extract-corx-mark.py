#!/usr/bin/env python3
"""
Extract the CorX Labs mark from Cormorant Garamond as an SVG path.

assets/img/logo.png is a capital C set in Cormorant Garamond — the same face
the site's CSS mark uses. Rather than trace the bitmap or redraw it by eye,
this pulls the real glyph outline out of the font at the same weight the CSS
renders (500), so the benchmark index shows the actual letterform.

    pip install fonttools
    python3 tools/extract-corx-mark.py

Prints the path; paste it into CORX_PATH in tools/vendor-logos.py, then rerun
that to regenerate assets/img/logos/corx.svg.
"""

import os
import sys
import urllib.request

FONT_URL = ("https://raw.githubusercontent.com/google/fonts/main/ofl/"
            "cormorantgaramond/CormorantGaramond%5Bwght%5D.ttf")
WEIGHT = 500          # matches .mark in assets/css/main.css
CAP_FRACTION = 0.62   # how much of the 24x24 box the C fills, matching logo.png


def main():
    from fontTools.ttLib import TTFont
    from fontTools.varLib.instancer import instantiateVariableFont
    from fontTools.pens.svgPathPen import SVGPathPen
    from fontTools.pens.transformPen import TransformPen
    from fontTools.pens.boundsPen import BoundsPen
    from fontTools.misc.transform import Transform

    path = sys.argv[1] if len(sys.argv) > 1 else "/tmp/cormorant.ttf"
    if not os.path.exists(path):
        urllib.request.urlretrieve(FONT_URL, path)

    font = instantiateVariableFont(TTFont(path), {"wght": WEIGHT}, inplace=False,
                                   updateFontNames=False)
    glyphs = font.getGlyphSet()
    glyph = glyphs[font.getBestCmap()[ord("C")]]

    bounds = BoundsPen(glyphs)
    glyph.draw(bounds)
    x0, y0, x1, y1 = bounds.bounds
    w, h = x1 - x0, y1 - y0

    scale = (24 * CAP_FRACTION) / h
    tx = (24 - w * scale) / 2 - x0 * scale
    ty = (24 + h * scale) / 2 + y0 * scale   # font Y is up, SVG Y is down

    pen = SVGPathPen(glyphs)
    glyph.draw(TransformPen(pen, Transform(scale, 0, 0, -scale, tx, ty)))
    print(pen.getCommands())


if __name__ == "__main__":
    main()
