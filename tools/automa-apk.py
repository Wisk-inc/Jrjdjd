#!/usr/bin/env python3
"""A new Automa APK on the site: the parts that are not writing.

  python3 tools/automa-apk.py check NEW.apk       what the APK is, and whether it can replace the one on the site
  python3 tools/automa-apk.py card VERSION        assets/img/og-automa-<version>.jpg from the current card
  python3 tools/automa-apk.py redirects VERSION   every older APK link to /downloads/Automa-<version>.apk

The APK comes from Wisk-inc/paperclip, branch claude/automa-android-apk-uiimmy, releases/android/. The steps
for a release are in .claude/CLAUDE.md ("Automa releases").

check prints versionCode, versionName, package, the APK signing certificate's SHA-256, size and SHA-256 for
the new APK and for the one in downloads/, and exits 0 only when the new one can replace it: the same package,
a higher versionCode and the same signing certificate (so it installs over the old one and keeps data).

card copies the current share card and redraws only the version in its footnote, in the site's own Inter.
The old card stays: links shared earlier still show it. Needs Pillow.

redirects points every /downloads/Automa-*.apk redirect in vercel.json and _redirects at the new version and
adds one for the version being replaced. Run it after the APK in downloads/ is renamed to the new version.
"""
import hashlib
import re
import struct
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PACKAGE = "com.corxlabs.automa"


def current_apk():
    apks = sorted(ROOT.glob("downloads/Automa-*.apk"), key=lambda p: [int(x) for x in p.stem.split("-")[1].split(".")])
    if not apks:
        sys.exit("No Automa APK in downloads/")
    return apks[-1]


# ---- the binary AndroidManifest.xml: versionCode, versionName, package
def _strings(buf, off):
    _t, hsize, size = struct.unpack_from("<HHI", buf, off)
    count, _styles, flags, s_start, _st = struct.unpack_from("<IIIII", buf, off + 8)
    utf8 = flags & 0x100
    offsets = struct.unpack_from("<%dI" % count, buf, off + hsize)
    out = []
    for o in offsets:
        p = off + s_start + o
        if utf8:
            p += 2 if buf[p] & 0x80 else 1
            n = buf[p]
            if n & 0x80:
                n = ((n & 0x7F) << 8) | buf[p + 1]
                p += 2
            else:
                p += 1
            out.append(buf[p:p + n].decode("utf-8", "replace"))
        else:
            n = struct.unpack_from("<H", buf, p)[0]
            p += 2
            if n & 0x8000:
                n = ((n & 0x7FFF) << 16) | struct.unpack_from("<H", buf, p)[0]
                p += 2
            out.append(buf[p:p + 2 * n].decode("utf-16le", "replace"))
    return out, off + size


def manifest(path):
    buf = zipfile.ZipFile(path).read("AndroidManifest.xml")
    pool, off = _strings(buf, 8)
    found = {}
    while off < len(buf):
        kind, _hsize, size = struct.unpack_from("<HHI", buf, off)
        if kind == 0x0102:  # start of an element
            _ns, name, a_start, a_size, a_count = struct.unpack_from("<iiHHH", buf, off + 16)
            if pool[name] == "manifest":
                p = off + 16 + a_start
                for k in range(a_count):
                    _ns, aname, raw, _vs, _r, _dtype, data = struct.unpack_from("<iiiHBBI", buf, p + k * a_size)
                    key = pool[aname]
                    if key in ("versionCode", "versionName", "package"):
                        found[key] = pool[raw] if raw >= 0 else data
                break
        off += size
    return found


# ---- the APK signing block: SHA-256 of each signing certificate (schemes v2, v3, v3.1)
def certificates(data):
    eocd = data.rfind(b"PK\x05\x06")
    cd_offset = struct.unpack("<I", data[eocd + 16:eocd + 20])[0]
    if data[cd_offset - 16:cd_offset] != b"APK Sig Block 42":
        return {}
    size = struct.unpack("<Q", data[cd_offset - 24:cd_offset - 16])[0]
    block = data[cd_offset - size - 8 + 8:cd_offset - 24]

    def lp(buf, i):
        n = struct.unpack("<I", buf[i:i + 4])[0]
        return buf[i + 4:i + 4 + n], i + 4 + n

    found, i = {}, 0
    while i < len(block):
        n = struct.unpack("<Q", block[i:i + 8])[0]
        ident = struct.unpack("<I", block[i + 8:i + 12])[0]
        value = block[i + 12:i + 8 + n]
        i += 8 + n
        scheme = {0x7109871A: "v2", 0xF05368C0: "v3", 0x1B93AD61: "v3.1"}.get(ident)
        if not scheme:
            continue
        signers, _ = lp(value, 0)
        out, j = [], 0
        while j < len(signers):
            signer, j = lp(signers, j)
            signed, _ = lp(signer, 0)
            _digests, k = lp(signed, 0)
            certs, _ = lp(signed, k)
            m = 0
            while m < len(certs):
                cert, m = lp(certs, m)
                out.append(hashlib.sha256(cert).hexdigest())
        found[scheme] = out
    return found


def describe(path):
    data = Path(path).read_bytes()
    info = manifest(path)
    info.update(size=len(data), sha256=hashlib.sha256(data).hexdigest(), certificates=certificates(data))
    info["signers"] = sorted({c for certs in info["certificates"].values() for c in certs})
    return info


def check(new_path):
    old_path = current_apk()
    new, old = describe(new_path), describe(old_path)
    for label, path, info in (("new", new_path, new), ("on the site", old_path, old)):
        print(f"{label}: {Path(path).name}  versionName {info.get('versionName')}  versionCode {info.get('versionCode')}  "
              f"package {info.get('package')}  {info['size']:,} bytes  SHA-256 {info['sha256']}")
        print(f"  signing certificates: {info['certificates'] or 'none found'}")
    problems = []
    if new.get("package") != PACKAGE:
        problems.append(f"the package is {new.get('package')}, not {PACKAGE}")
    if not isinstance(new.get("versionCode"), int) or new["versionCode"] <= old.get("versionCode", 0):
        problems.append(f"versionCode {new.get('versionCode')} is not higher than the site's {old.get('versionCode')}")
    if not new["signers"] or new["signers"] != old["signers"]:
        problems.append("it is not signed with the same certificate as the APK on the site, so it would not install over it")
    if problems:
        print("Do not publish it: " + "; ".join(problems) + ".")
        return 1
    print(f"OK: {new['versionName']} (versionCode {new['versionCode']}) can replace {old['versionName']}, "
          f"same certificate, so it installs over it.")
    return 0


def card(version):
    from PIL import Image, ImageChops, ImageDraw, ImageFont

    old_version = current_apk().stem.split("-", 1)[1]
    cards = {p.stem.removeprefix("og-automa-").replace("-", "."): p for p in ROOT.glob("assets/img/og-automa-*.jpg")}
    source = cards.get(old_version) or cards[max(cards, key=lambda v: [int(x) for x in v.split(".")])]
    src_version = source.stem.removeprefix("og-automa-").replace("-", ".")
    target = ROOT / "assets/img" / f"og-automa-{version.replace('.', '-')}.jpg"
    font_file = sorted(ROOT.glob("assets/fonts/inter-latin.*.woff2"))[0]
    bg, ink = (237, 234, 227), (123, 119, 111)
    src = Image.open(source).convert("RGB")
    font = ImageFont.truetype(str(font_file), 17.9)

    def render(text, xy, base=None):
        im = (base or Image.new("RGB", src.size, bg)).copy()
        ImageDraw.Draw(im).text(xy, text, font=font, fill=ink)
        return im

    # Find where the old version is drawn in the footnote, to a quarter of a pixel
    old_text, box = f"v{src_version}", (380, 495, 530, 525)
    def score(x, y):
        return sum(ImageChops.difference(render(old_text, (x, y)).crop(box), src.crop(box)).convert("L").getdata())
    _, bx, by = min((score(x, y), x, y) for x in range(420, 470) for y in range(495, 505))
    best, x, y = min((score(bx + dx / 4, by + dy / 4), bx + dx / 4, by + dy / 4) for dx in range(-4, 5) for dy in range(-4, 5))
    if best > 60000:
        sys.exit(f"Could not find {old_text} in {source.name}'s footnote (best match {best}); make the card by hand")
    measure = ImageDraw.Draw(Image.new("RGB", src.size))
    old_box = measure.textbbox((x, y), old_text, font=font)
    new_box = measure.textbbox((x, y), f"v{version}", font=font)
    out = src.copy()
    ImageDraw.Draw(out).rectangle((old_box[0] - 3, old_box[1] - 3, max(old_box[2], new_box[2]) + 4, old_box[3] + 4), fill=bg)
    out = render(f"v{version}", (x, y), out)
    changed = ImageChops.difference(out, src).convert("L").point(lambda v: 255 if v > 8 else 0).getbbox()
    out.save(target, "JPEG", quality=92, optimize=True, progressive=True)
    print(f"wrote {target.relative_to(ROOT)} from {source.name}: only {changed} changed (the footnote)")
    return 0


def redirects(version):
    new = f"/downloads/Automa-{version}.apk"
    if not (ROOT / new.lstrip("/")).exists():
        sys.exit(f"{new} is not in downloads/ yet: rename the APK first")
    vercel = ROOT / "vercel.json"
    text = vercel.read_text(encoding="utf-8")
    entry = re.compile(r'    \{\n      "source": "/downloads/Automa-([\d.]+)\.apk",\n      "destination": "/downloads/Automa-[\d.]+\.apk",\n'
                       r'      "permanent": false\n    \},?\n')
    found = list(entry.finditer(text))
    if not found:
        sys.exit("No Automa redirects found in vercel.json")
    sources = [m.group(1) for m in found]
    text = re.sub(r'("destination": ")/downloads/Automa-[\d.]+\.apk(")', rf'\g<1>{new}\g<2>', text)
    # Every version these files mention (sources and the old destination) other than the new one
    old_versions = sorted(set(sources + [m for m in re.findall(r"Automa-([\d.]+)\.apk", (ROOT / "_redirects").read_text())]) - {version},
                          key=lambda v: [int(x) for x in v.split(".")])
    missing = [v for v in old_versions if v not in sources]
    last = list(entry.finditer(text))[-1]
    block = "".join(f'    {{\n      "source": "/downloads/Automa-{v}.apk",\n      "destination": "{new}",\n      "permanent": false\n    }},\n'
                    for v in missing)
    end = last.end()
    if not last.group(0).rstrip("\n").endswith(","):  # the last Automa entry ended the list: keep the JSON valid
        text = text[:last.end() - 1] + ",\n" + block.rstrip(",\n") + "\n" + text[last.end():]
    else:
        text = text[:end] + block + text[end:]
    import json
    json.loads(text)
    vercel.write_text(text, encoding="utf-8")

    netlify = ROOT / "_redirects"
    lines = netlify.read_text(encoding="utf-8").splitlines(keepends=True)
    out, last_index = [], None
    for line in lines:
        m = re.match(r"(/downloads/Automa-([\d.]+)\.apk)\s+/downloads/Automa-[\d.]+\.apk\s+302!\n?", line)
        if m:
            line = f"{m.group(1)}  {new}  302!\n"
            last_index = len(out)
        out.append(line)
    have = {re.match(r"/downloads/Automa-([\d.]+)\.apk", l).group(1) for l in out if l.startswith("/downloads/Automa-")}
    add = [f"/downloads/Automa-{v}.apk  {new}  302!\n" for v in old_versions if v not in have]
    if last_index is None:
        sys.exit("No Automa redirects found in _redirects")
    out[last_index + 1:last_index + 1] = add
    netlify.write_text("".join(out), encoding="utf-8")
    print(f"vercel.json and _redirects: every older APK goes to {new}; added {', '.join(missing) or 'nothing'}")
    return 0


if __name__ == "__main__":
    if len(sys.argv) != 3 or sys.argv[1] not in ("check", "card", "redirects"):
        sys.exit(__doc__)
    sys.exit({"check": check, "card": card, "redirects": redirects}[sys.argv[1]](sys.argv[2]))
