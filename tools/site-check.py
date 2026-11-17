#!/usr/bin/env python3
"""What is the live site serving?  python3 tools/site-check.py [https://corx-labs.com]

Run by .github/workflows/site-check.yml on a GitHub runner, which can reach the site. Run it from a
checkout of main with its history (fetch-depth 0). It changes nothing and reports:

- which host answers, from the response headers, and the DNS records;
- for each file checked, whether the live copy is the one on main, and if not, which commit of this
  repository it matches (by git blob hash), so the deployed version is known;
- the Automa APK's size and SHA-256 against the copy on main, and the redirects from old versions;
- the www redirect, the Content-Security-Policy (the Scam Radar page needs raw.githubusercontent.com in
  connect-src to load fresh data) and whether the scan API answers;
- how old the published Scam Radar data is.
- what Vercel reported to GitHub about the latest commits on main and the data branch (needs
  GITHUB_TOKEN with read access to statuses, checks and deployments).

It writes the same summary to $GITHUB_STEP_SUMMARY when that is set. It exits with 1 only when the
site cannot be reached at all.
"""
import hashlib
import json
import os
import re
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlsplit

SITE = (sys.argv[1] if len(sys.argv) > 1 else "https://corx-labs.com").rstrip("/")
ROOT = Path(__file__).resolve().parent.parent
UA = "corx-labs-site-check/1 (+https://github.com/Wisk-inc/Jrjdjd)"
DATA = "https://raw.githubusercontent.com/Wisk-inc/Jrjdjd/scam-radar-data/scam-radar-status.json"
REPO = os.environ.get("GITHUB_REPOSITORY", "Wisk-inc/Jrjdjd")

# The newest Automa APK on main, and the older ones whose links should redirect to it
APKS = sorted((ROOT / "downloads").glob("Automa-*.apk"), key=lambda p: [int(x) for x in p.stem.split("-")[1].split(".")])
AUTOMA = APKS[-1].stem.split("-", 1)[1]
OLD_APKS = [line.split()[0] for line in (ROOT / "_redirects").read_text(encoding="utf-8").splitlines()
            if line.startswith("/downloads/Automa-")]

# Path on the site -> file in this repository, and text the version on main must contain
PAGES = [
    ("/", "index.html", [f"Automa {AUTOMA}", "CorxLabs/Pluvium-500"]),
    ("/models/pluvium/", "models/pluvium/index.html", ["CorxLabs/Pluvium-500/tree/main/checkpoint/stage_a/best"]),
    ("/scam-radar/", "scam-radar/index.html", ["sr-check-input", "scam-finder-core.js"]),
    ("/scam-radar/map/", "scam-radar/map/index.html", ["scam-map-boot.js"]),
    ("/automa/", "automa/index.html", [f"Automa-{AUTOMA}.apk"]),
    ("/nathan/", "nathan/index.html", []),
    ("/developers/", "developers/index.html", []),
]
FILES = [
    "llms.txt", "llms-full.txt", "feed.xml", "sitemap.xml", "robots.txt",
    "assets/css/main.css", "assets/css/scam-radar.css", "assets/css/scam-map.css",
    "assets/js/main.js", "assets/js/scam-radar.js", "assets/js/scam-finder-core.js",
    "assets/js/scam-map.js", "assets/js/scam-map-boot.js", "assets/data/scam-radar.json",
]
HOST_HEADERS = ["server", "via", "x-vercel-id", "x-vercel-cache", "x-nf-request-id", "cf-ray", "cf-cache-status",
                "x-github-request-id", "x-served-by", "x-cache", "x-amz-cf-id", "age", "last-modified", "etag",
                "cache-control", "strict-transport-security"]

report, problems = [], []


def say(line=""):
    print(line, flush=True)
    report.append(line)


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


def fetch(url, follow=True, method="GET", limit=None):
    """(status, headers, body bytes, final url, error). Never raises."""
    opener = urllib.request.build_opener() if follow else urllib.request.build_opener(NoRedirect)
    req = urllib.request.Request(url, method=method, headers={"User-Agent": UA, "Accept-Encoding": "identity",
                                                               "Cache-Control": "no-cache"})
    try:
        with opener.open(req, timeout=60) as r:
            body = r.read(limit) if method == "GET" else b""
            return r.status, {k.lower(): v for k, v in r.headers.items()}, body, r.geturl(), None
    except urllib.error.HTTPError as e:
        body = e.read(4096) if method == "GET" else b""
        return e.code, {k.lower(): v for k, v in e.headers.items()}, body, url, None
    except Exception as e:  # DNS, TLS, timeout
        return None, {}, b"", url, f"{type(e).__name__}: {e}"


def blob_id(data: bytes) -> str:
    return hashlib.sha1(b"blob %d\0" % len(data) + data).hexdigest()


def history(path: str):
    """[(commit, date, blob)] newest first: each commit on HEAD that changed the file."""
    out = subprocess.run(["git", "log", "--format=@%h %cI", "--raw", "--no-abbrev", "--no-renames", "HEAD", "--", path],
                         cwd=ROOT, capture_output=True, text=True).stdout
    rows, commit = [], None
    for line in out.splitlines():
        if line.startswith("@"):
            commit = line[1:].split(" ", 1)
        elif line.startswith(":") and commit:
            parts = line.split()
            rows.append((commit[0], commit[1][:16].replace("T", " "), parts[3]))
    return rows


def which_version(path: str, data: bytes) -> str:
    rows = history(path)
    live = blob_id(data)
    for i, (commit, date, blob) in enumerate(rows):
        if blob == live:
            return "same as main" if i == 0 else f"OLD: matches {commit} ({date} UTC), {i} change(s) behind main"
    return "matches no commit (changed by the host, or not from this repository)"


def guess_host(h: dict) -> str:
    server = h.get("server", "").lower()
    if "x-vercel-id" in h or "vercel" in server:
        return "Vercel"
    if "x-nf-request-id" in h or "netlify" in server:
        return "Netlify"
    if "x-github-request-id" in h or server == "github.com":
        return "GitHub Pages"
    if "cf-ray" in h or "cloudflare" in server:
        return "Cloudflare (Pages, or Cloudflare in front of another host)"
    return "unknown"


def main():
    say(f"Site check of {SITE}, {datetime.now(timezone.utc):%Y-%m-%d %H:%M} UTC")
    head = subprocess.run(["git", "log", "-1", "--format=%h %cI %s", "HEAD"], cwd=ROOT, capture_output=True, text=True).stdout.strip()
    say(f"Compared with main at {head}")
    say()

    host = urlsplit(SITE).hostname
    say("## DNS")
    try:
        addrs = sorted({ai[4][0] for ai in socket.getaddrinfo(host, 443)})
        say(f"{host} -> {', '.join(addrs)}")
    except Exception as e:
        say(f"{host} does not resolve: {e}")
        problems.append(f"{host} does not resolve")
    for kind in ("CNAME", "A", "AAAA", "NS"):
        try:
            got = subprocess.run(["dig", "+short", kind, host], capture_output=True, text=True, timeout=20).stdout.split()
            if got:
                say(f"{kind}: {' '.join(got)}")
        except Exception:
            break
    say()

    say("## Who answers")
    status, h, body, final, err = fetch(SITE + "/")
    if err or status is None:
        say(f"The site did not answer: {err}")
        problems.append(f"{SITE}/ did not answer")
        finish(exit_code=1)
    say(f"GET / -> {status}, {len(body):,} bytes, final address {final}")
    # Where visitors end up must be the address the pages name as theirs
    canonical = re.search(r'<link rel="canonical" href="([^"]+)"', body.decode("utf-8", "replace"))
    canon_host = urlsplit(canonical.group(1)).hostname if canonical else None
    final_host = urlsplit(final).hostname
    if canon_host and canon_host != final_host:
        say(f"  visitors end up on {final_host}, but the pages name {canon_host} as their address")
        problems.append(f"visitors end up on {final_host} but the canonical links say {canon_host}: the host's domain "
                        f"settings and the site's links disagree")
    else:
        say(f"  visitors end up on {final_host}, the address the pages name as theirs")
    say(f"Host: {guess_host(h)}")
    for name in HOST_HEADERS:
        if name in h:
            say(f"  {name}: {h[name]}")
    csp = h.get("content-security-policy", "")
    if not csp:
        say("  content-security-policy: none sent")
        problems.append("no Content-Security-Policy header on /")
    else:
        connect = next((d for d in csp.split(";") if d.strip().startswith("connect-src")), "")
        ok = "raw.githubusercontent.com" in connect
        say(f"  CSP connect-src allows raw.githubusercontent.com: {'yes' if ok else 'NO'}")
        if not ok:
            problems.append("the live CSP blocks raw.githubusercontent.com, so Scam Radar cannot load fresh data")
        local = (ROOT / "_headers").read_text(encoding="utf-8")
        same = csp.strip() in local
        say(f"  CSP is the one in _headers: {'yes' if same else 'no (another config, or an edited copy)'}")
    say()

    say("## Pages")
    for path, local, markers in PAGES:
        status, h, body, final, err = fetch(SITE + path)
        if err or status != 200:
            say(f"{path}: {err or status}")
            problems.append(f"{path} answered {err or status}")
            continue
        version = which_version(local, body)
        text = body.decode("utf-8", "replace")
        missing = [m for m in markers if m not in text]
        say(f"{path}: {status}, {version}" + (f"; MISSING {missing}" if missing else ""))
        if missing or version.startswith("OLD"):
            problems.append(f"{path} is not the version on main")
    say()

    say("## Files")
    for path in FILES:
        status, h, body, final, err = fetch(f"{SITE}/{path}")
        if err or status != 200:
            say(f"/{path}: {err or status}")
            problems.append(f"/{path} answered {err or status}")
            continue
        version = which_version(path, body)
        say(f"/{path}: {version}")
        if version.startswith("OLD"):
            problems.append(f"/{path} is an old version")
    say()

    say("## Automa APK")
    newest = APKS[-1]
    want = hashlib.sha256(newest.read_bytes()).hexdigest()
    status, h, body, final, err = fetch(f"{SITE}/downloads/{newest.name}")
    got = hashlib.sha256(body).hexdigest() if body else ""
    ok = status == 200 and got == want
    say(f"/downloads/{newest.name}: {err or status}, {len(body):,} bytes, type {h.get('content-type', '?')}, "
        f"SHA-256 {'matches main' if ok else 'DIFFERS: ' + got[:16]}")
    if not ok:
        problems.append(f"the live {newest.name} is not the file on main")
    for old in OLD_APKS:
        # Follow the redirects (the www one included) and say where an old link ends up
        status, h, body, final, err = fetch(SITE + old, method="HEAD")
        ends = urlsplit(final).path
        ok = ends == f"/downloads/{newest.name}"
        say(f"{old} -> {err or status} at {ends}" + ("" if ok else f" (NOT {newest.name})"))
        if not ok:
            problems.append(f"{old} does not lead to {newest.name}")
    say()

    say("## Redirects")
    www = SITE.replace("://", "://www.", 1)
    status, h, body, final, err = fetch(www + "/", follow=False, method="HEAD")
    say(f"{www}/ -> {err or status} {h.get('location', '')}")
    status, h, body, final, err = fetch(SITE + "/scam-radar", follow=False, method="HEAD")
    say(f"{SITE}/scam-radar -> {err or status} {h.get('location', '')}")
    say()

    say("## Scan API (link checks that visit the page)")
    for path in ("/api/scam-finder?ping=1", "/.netlify/functions/scam-finder?ping=1"):
        status, h, body, final, err = fetch(SITE + path)
        text = body[:200].decode("utf-8", "replace").replace("\n", " ")
        try:
            answer = json.loads(body)
            text = json.dumps(answer)[:200]
        except Exception:
            text = f"not JSON: {text[:80]!r}"
        say(f"{path}: {err or status}, {text}")
    # The contact check, on a made-up Jamaican number (555-01xx is reserved for fiction); it asks no one else
    status, h, body, final, err = fetch(SITE + "/api/scam-finder?contact=%2B18765550100")
    say(f"/api/scam-finder?contact=+18765550100: {err or status}, {body[:220].decode('utf-8', 'replace')}")
    say()

    say("## Scam Radar status function (the page reads data at the branch's current commit through it)")
    status, h, body, final, err = fetch(SITE + "/api/scam-radar-status")
    try:
        answer = json.loads(body)
        made = datetime.fromisoformat(answer["generated"].replace("Z", "+00:00"))
        age = (datetime.now(timezone.utc) - made).total_seconds()
        scan = answer.get("scan") or {}
        say(f"/api/scam-radar-status: {status}, commit {answer['commit'][:10]}, published {age:.0f} s ago, "
            f"scan {scan.get('state')} cycle {scan.get('cycle')} of {scan.get('cycles')}")
    except Exception:
        say(f"/api/scam-radar-status: {err or status}, {body[:120]!r}")
        problems.append("the Scam Radar status function did not answer; the page falls back to data that can be minutes old")
    say()

    say("## Scam Radar data")
    status, h, body, final, err = fetch(f"{DATA}?t={int(time.time())}")
    try:
        snap = json.loads(body)
        made = datetime.fromisoformat(snap["generated"].replace("Z", "+00:00"))
        minutes = (datetime.now(timezone.utc) - made).total_seconds() / 60
        say(f"Last published {snap['generated']} ({minutes:.0f} minutes ago), {snap.get('scanCycles')} scan cycles in all")
        if minutes > 120:
            problems.append(f"the Scam Radar data is {minutes:.0f} minutes old")
    except Exception as e:
        say(f"Could not read {DATA}: {err or status} {e}")
        problems.append("the Scam Radar data could not be read")
    say()
    deployments()
    finish()


def github(path):
    """GET from GitHub's API for this repository, with the workflow's token when there is one."""
    headers = {"Accept": "application/vnd.github+json", "User-Agent": UA}
    if os.environ.get("GITHUB_TOKEN"):
        headers["Authorization"] = f"Bearer {os.environ['GITHUB_TOKEN']}"
    request = urllib.request.Request(f"https://api.github.com/repos/{REPO}/{path}", headers=headers)
    with urllib.request.urlopen(request, timeout=20) as answer:
        return json.load(answer)


def deployments():
    """What Vercel says about the latest commits, from the statuses and deployments it reports to GitHub."""
    say("## Deployments (what Vercel reported to GitHub)")
    try:
        log = subprocess.run(["git", "log", "-5", "--first-parent", "--format=%H %cI %s", "HEAD"], cwd=ROOT,
                             capture_output=True, text=True, check=True).stdout.splitlines()
        data = subprocess.run(["git", "ls-remote", "origin", "refs/heads/scam-radar-data"], cwd=ROOT,
                              capture_output=True, text=True).stdout.split()
        commits = [(line.split(" ", 2)[0], f"main {line.split(' ', 2)[1][:16]} {line.split(' ', 2)[2][:60]}") for line in log]
        if data:
            commits.append((data[0], "scam-radar-data head"))
        for sha, label in commits:
            say(f"{sha[:10]} ({label})")
            seen = set()
            for st in github(f"commits/{sha}/statuses?per_page=30"):
                if st.get("context") in seen:
                    continue
                seen.add(st.get("context"))
                say(f"  status {st.get('context')}: {st.get('state')}, {st.get('description')} ({st.get('created_at')})")
            for run in github(f"commits/{sha}/check-runs?per_page=20").get("check_runs", []):
                out = run.get("output") or {}
                text = " ".join(filter(None, [out.get("title"), (out.get("summary") or "")[:300]]))
                say(f"  check {run.get('name')}: {run.get('status')}/{run.get('conclusion')} {text}".rstrip())
            for dep in github(f"deployments?sha={sha}&per_page=10"):
                states = github(f"deployments/{dep['id']}/statuses?per_page=5")
                last = states[0] if states else {}
                say(f"  deployment to {dep.get('environment')} at {dep.get('created_at')}: {last.get('state')}, "
                    f"{last.get('description') or ''}".rstrip(", "))
            if not seen:
                say("  no statuses")
        # How many deployments the data branch has started in the last day (it should be none)
        day_ago = datetime.now(timezone.utc).timestamp() - 86400
        recent = [d for d in github("deployments?ref=scam-radar-data&per_page=100")
                  if datetime.fromisoformat(d["created_at"].replace("Z", "+00:00")).timestamp() > day_ago]
        say(f"Deployments of the scam-radar-data branch in the last 24 hours: {len(recent)}{' (100 or more)' if len(recent) >= 100 else ''}")
        if recent:
            problems.append(f"Vercel deployed the scam-radar-data branch {len(recent)} times in the last day")
    except Exception as e:  # the token may lack the permissions; the rest of the report still stands
        say(f"Could not read the deployments: {e}")
    say()


def finish(exit_code=0):
    say("## Problems" if problems else "## No problems found")
    for p in problems:
        say(f"- {p}")
    summary = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary:
        with open(summary, "a", encoding="utf-8") as f:
            f.write("\n".join(l if l.startswith(("#", "-")) or not l else l + "  " for l in report) + "\n")
    sys.exit(exit_code)


if __name__ == "__main__":
    main()
