"""House-style check (see .claude/CLAUDE.md): em dashes, filler words, self-praise and
"not just X but Y" in the visible text of the hand-written pages.  python3 tools/style-check.py"""
import html, re, sys
from pathlib import Path
ROOT = Path(__file__).resolve().parent.parent
VOCAB = r"delve|tapestry|testament|pivotal|underscor\w*|showcas\w*|seamless\w*|robust|landscape|realm|crucial|vibrant|garner\w*|foster\w*|enhanc\w*|align(?:s|ed)? with|interplay|meticulous\w*|notably|comprehensive|boast\w*|nestled|groundbreaking|renowned|additionally|moreover|furthermore|in summary|it is important to note|navigat\w+ the|ever-evolving|cutting-edge|empower\w*|unlock\w*|harness\w*|elevat\w*|game-chang\w*|journey|stands as|serves as|plays a (?:key|vital|crucial) role|key (?:role|insight)|truly|deeply|plainly|honest(?:ly)? (?:about|answer|limits|note|scope)"
NEG = r"\bnot (?:just|only|merely)\b|\bisn[’']t (?:just|only)\b|\bnot [^.;,]{1,40}, but\b|\brather than\b"
ING = r",\s(?:highlighting|underscoring|emphasizing|reflecting|showcasing|ensuring|contributing|making it|marking|signaling)\b"
def text(path):
    s = path.read_text(encoding="utf-8")
    s = re.sub(r"<(script|style|svg)[^>]*>.*?</\1>", " ", s, flags=re.S)
    s = re.sub(r"<(pre|code|blockquote)[^>]*>.*?</\1>", " ", s, flags=re.S)
    m = re.search(r"<main.*?</main>", s, re.S)
    s = m.group(0) if m else s
    return html.unescape(re.sub(r"<[^>]+>", " ", s))
pages = sorted(p for p in ROOT.rglob("index.html") if "benchmarks" not in p.parts and ".git" not in p.parts) + [ROOT / "404.html"]
rows = []
for p in pages:
    t = text(p); words = len(t.split()) or 1
    em = t.count("—")
    v = re.findall(VOCAB, t, re.I); n = re.findall(NEG, t, re.I); g = re.findall(ING, t, re.I)
    rows.append((p.relative_to(ROOT).as_posix(), words, em, len(v), len(n), len(g), v))
print(f"{'page':48} {'words':>6} {'—':>4} {'/1k':>5} {'vocab':>5} {'neg':>4} {'-ing':>4}")
for r in sorted(rows, key=lambda r: -(r[2] + r[3] + r[4] + r[5])):
    print(f"{r[0]:48} {r[1]:6} {r[2]:4} {r[2]/r[1]*1000:5.1f} {r[3]:5} {r[4]:4} {r[5]:4}")
from collections import Counter
c = Counter(w.lower() for r in rows for w in r[6])
print("\nmost common flagged words:", c.most_common(25))
