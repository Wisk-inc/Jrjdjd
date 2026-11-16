#!/usr/bin/env bash
# Publish Scam Radar's snapshot: every file in a folder, as one commit, force-pushed to the
# scam-radar-data branch. One commit only, so the snapshots never pile up in the history.
#
#   GH_TOKEN=... GITHUB_REPOSITORY=owner/repo tools/scam-radar/publish.sh <folder>
set -euo pipefail

src="${1:?give the folder to publish}"
work="$(mktemp -d)"
cp -R "$src"/. "$work"/
cd "$work"
git init -q -b scam-radar-data
git config user.name "github-actions[bot]"
git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
git add -A
git commit -q -m "Scam Radar: snapshot $(date -u +%Y-%m-%dT%H:%MZ)"
for attempt in 1 2 3; do
  if git push -q -f "https://x-access-token:${GH_TOKEN}@github.com/${GITHUB_REPOSITORY}.git" scam-radar-data; then
    echo "Published $(find . -type f -not -path './.git/*' | wc -l) file(s) to scam-radar-data"
    exit 0
  fi
  sleep $((attempt * 15))
done
echo "::warning::could not publish the snapshot"
exit 1
