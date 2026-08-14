#!/usr/bin/env python3
"""Generate the CorX Labs brand raster assets: favicons, app icons, OG cards."""
import os, random
from PIL import Image, ImageDraw, ImageFont, ImageFilter

OUT = "/home/user/Jrjdjd/assets/img"
SCRATCH = os.path.dirname(os.path.abspath(__file__))
os.makedirs(OUT, exist_ok=True)

PAPER = (244, 242, 236)
PAPER_RAISED = (250, 249, 245)
ESPRESSO = (61, 48, 37)
INK = (33, 26, 19)
MUTED = (109, 99, 87)
FAINT = (147, 137, 124)

CORMORANT = os.environ.get("CORMORANT_TTF", os.path.join(SCRATCH, "cormorant.ttf"))
SANS = "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf"
SANS_BOLD = "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf"


def serif(size, weight=600):
    f = ImageFont.truetype(CORMORANT, size)
    try:
        f.set_variation_by_axes([weight])
    except Exception:
        pass
    return f


def sans(size, bold=False):
    return ImageFont.truetype(SANS_BOLD if bold else SANS, size)


def grain(img, strength=9):
    """Subtle paper grain, matching the texture in the original mark."""
    w, h = img.size
    noise = Image.new("L", (w // 2, h // 2))
    rnd = random.Random(7)
    noise.putdata([128 + rnd.randint(-strength, strength) for _ in range(noise.width * noise.height)])
    noise = noise.resize((w, h), Image.BILINEAR).filter(ImageFilter.GaussianBlur(0.4))
    return Image.blend(img, Image.merge("RGB", (noise, noise, noise)), 0.055)


def draw_c(draw, box, size, color=ESPRESSO, weight=600):
    """Center the Cormorant 'C' optically inside `box` = (x0, y0, x1, y1)."""
    font = serif(size, weight)
    l, t, r, b = draw.textbbox((0, 0), "C", font=font)
    x0, y0, x1, y1 = box
    x = x0 + ((x1 - x0) - (r - l)) / 2 - l
    y = y0 + ((y1 - y0) - (b - t)) / 2 - t
    draw.text((x, y), "C", font=font, fill=color)


def tracked(draw, xy, text, font, fill, tracking):
    """Letter-spaced text (the small-caps wordmark treatment)."""
    x, y = xy
    for ch in text:
        draw.text((x, y), ch, font=font, fill=fill)
        x += draw.textlength(ch, font=font) + tracking
    return x - tracking


def tracked_width(draw, text, font, tracking):
    return sum(draw.textlength(c, font=font) for c in text) + tracking * (len(text) - 1)


# ---------------------------------------------------------------- icons
def icon(size, pad_ratio=0.0, bg=PAPER, radius=None, transparent=False):
    ss = 4
    s = size * ss
    img = Image.new("RGBA" if transparent else "RGB", (s, s), (0, 0, 0, 0) if transparent else bg)
    d = ImageDraw.Draw(img)
    if radius and not transparent:
        pass  # square icons; platforms apply their own masking
    pad = int(s * pad_ratio)
    glyph = int(s * 0.86)
    draw_c(d, (pad, pad, s - pad, s - pad), glyph, ESPRESSO, 600)
    img = img.resize((size, size), Image.LANCZOS)
    return img


for n in (16, 32, 48, 96, 192, 512):
    icon(n).save(f"{OUT}/icon-{n}.png")

# Apple touch icon: needs interior padding, opaque background.
icon(180, pad_ratio=0.17).save(f"{OUT}/apple-touch-icon.png")
# Maskable icon: 40% safe zone padding for Android adaptive masks.
icon(512, pad_ratio=0.22).save(f"{OUT}/icon-512-maskable.png")
# Square logo used in Organization schema / knowledge panel.
icon(512, pad_ratio=0.13).save(f"{OUT}/logo.png")

ico = Image.open(f"{OUT}/icon-48.png")
ico.save("/home/user/Jrjdjd/favicon.ico", sizes=[(16, 16), (32, 32), (48, 48)])

# ---------------------------------------------------------------- wordmark
def wordmark(path, w=1200, h=360):
    ss = 2
    img = Image.new("RGB", (w * ss, h * ss), PAPER)
    d = ImageDraw.Draw(img)
    W, H = w * ss, h * ss
    gsize = int(H * 0.62)
    f = serif(gsize, 600)
    l, t, r, b = d.textbbox((0, 0), "C", font=f)
    name_font = sans(int(H * 0.135), bold=True)
    tracking = int(H * 0.055)
    name_w = tracked_width(d, "CORX LABS", name_font, tracking)
    gap = int(H * 0.13)
    total = (r - l) + gap + name_w
    x = (W - total) / 2
    d.text((x - l, (H - (b - t)) / 2 - t), "C", font=f, fill=ESPRESSO)
    nl, nt, nr, nb = d.textbbox((0, 0), "CORX LABS", font=name_font)
    tracked(d, (x + (r - l) + gap, (H - (nb - nt)) / 2 - nt), "CORX LABS", name_font, INK, tracking)
    img.resize((w, h), Image.LANCZOS).save(path)


wordmark(f"{OUT}/logo-wordmark.png")

# ---------------------------------------------------------------- OG cards
def wrap(draw, text, font, max_w):
    words, lines, cur = text.split(), [], ""
    for word in words:
        trial = (cur + " " + word).strip()
        if draw.textlength(trial, font=font) <= max_w or not cur:
            cur = trial
        else:
            lines.append(cur)
            cur = word
    if cur:
        lines.append(cur)
    return lines


def og_card(path, eyebrow, title, footnote):
    ss = 2
    W, H = 1200 * ss, 630 * ss
    img = Image.new("RGB", (W, H), PAPER)
    d = ImageDraw.Draw(img)

    # Oversized watermark C, bleeding off the right edge.
    gf = serif(int(H * 1.15), 600)
    gl, gt, gr, gb = d.textbbox((0, 0), "C", font=gf)
    layer = Image.new("RGB", (W, H), PAPER)
    ld = ImageDraw.Draw(layer)
    ld.text((W - (gr - gl) * 0.80 - gl, (H - (gb - gt)) / 2 - gt), "C", font=gf, fill=ESPRESSO)
    img = Image.blend(img, layer, 0.085)
    d = ImageDraw.Draw(img)

    margin = int(76 * ss)
    d.rectangle([margin // 2, margin // 2, W - margin // 2, H - margin // 2],
                outline=(220, 216, 206), width=ss)

    x = margin + int(18 * ss)
    # Brand line
    bf = serif(int(52 * ss), 600)
    bl, bt, br, bb = d.textbbox((0, 0), "C", font=bf)
    d.text((x - bl, margin + int(22 * ss) - bt), "C", font=bf, fill=ESPRESSO)
    nf = sans(int(15 * ss), bold=True)
    tracked(d, (x + (br - bl) + int(14 * ss), margin + int(38 * ss)), "CORX LABS", nf, INK, int(3.4 * ss))

    # Eyebrow
    ef = sans(int(15 * ss), bold=True)
    ey_y = int(H * 0.44)
    tracked(d, (x, ey_y), eyebrow.upper(), ef, MUTED, int(3.2 * ss))

    # Title
    tf = serif(int(72 * ss), 600)
    max_w = W - x - margin - int(150 * ss)
    lines = wrap(d, title, tf, max_w)
    y = ey_y + int(44 * ss)
    for line in lines[:3]:
        d.text((x, y), line, font=tf, fill=(16, 12, 8))
        y += int(80 * ss)

    # Footnote
    ff = sans(int(19 * ss))
    d.text((x, H - margin - int(40 * ss)), footnote, font=ff, fill=FAINT)

    img = grain(img, 7)
    img.resize((1200, 630), Image.LANCZOS).save(path, quality=90, optimize=True, subsampling=0)


CARDS = [
    ("og-default.jpg", "AI research lab · Jamaica",
     "Architecting the future, from the ground up.",
     "corx-labs.com · Open-source language models built from scratch"),
    ("og-documentation.jpg", "Documentation",
     "What CorX Labs is, and how CorX1.5 works.",
     "corx-labs.com/documentation"),
    ("og-models.jpg", "Our products",
     "Open-source models released by CorX Labs.",
     "corx-labs.com/models"),
    ("og-corx1-5.jpg", "Model card",
     "CorX1.5 — a 158M parameter model trained from zero.",
     "corx-labs.com/models/corx1-5"),
    ("og-about.jpg", "About",
     "An independent AI research lab in the Caribbean.",
     "corx-labs.com/about"),
    ("og-contact.jpg", "Contact",
     "Business and research inquiries.",
     "corx-labs.com/contact"),
    ("og-blog.jpg", "Blog",
     "Notes from the lab.",
     "corx-labs.com/blog"),
    ("og-post-3b.jpg", "Technical breakdown",
     "3 billion tokens. One GPU.",
     "corx-labs.com/blog \u00b7 How CorX1.5 was trained"),
    ("og-developers.jpg", "Developers",
     "The people who built CorX1.5.",
     "corx-labs.com/developers"),
    ("og-tristream.jpg", "Model card",
     "TriStream-SVS \u2014 singing voice synthesis, factored by design.",
     "corx-labs.com/models/tristream-svs"),
]
for name, eyebrow, title, foot in CARDS:
    og_card(f"{OUT}/{name}", eyebrow, title, foot)

print("done:", sorted(os.listdir(OUT)))
