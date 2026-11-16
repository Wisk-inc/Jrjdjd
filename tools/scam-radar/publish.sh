#!/usr/bin/env bash
# Publish Scam Radar's files: everything in a folder, as the one commit on the scam-radar-data
# branch. The branch never grows a history: each publish replaces the commit and force-pushes.
#
#   GH_TOKEN=... GITHUB_REPOSITORY=owner/repo tools/scam-radar/publish.sh <folder>
#
# The clone it pushes from is kept between runs (next to Radar's database, so the Actions cache
# carries it). That way a publish sends only the files that changed since the last one.
set -euo pipefail

src="${1:?give the folder to publish}"
repo="${SCAM_RADAR_PUBLISH_DIR:-$HOME/.scam-finder/publish}"
branch="scam-radar-data"
remote="https://x-access-token:${GH_TOKEN}@github.com/${GITHUB_REPOSITORY}.git"

[ -d "$repo/.git" ] || git init -q -b "$branch" "$repo"
cd "$repo"
git config user.name "github-actions[bot]"
git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
git config gc.auto 0

# Make the working tree an exact copy of the folder
find . -mindepth 1 -maxdepth 1 ! -name .git -exec rm -rf {} +
cp -R "$src"/. .
git add -A
message="Scam Radar: snapshot $(date -u +%Y-%m-%dT%H:%MZ)"
if git rev-parse -q --verify HEAD >/dev/null; then
  git commit -q --amend --allow-empty -m "$message"
else
  git commit -q --allow-empty -m "$message"
fi

pushed=0
for attempt in 1 2 3; do
  if git push -q -f "$remote" "HEAD:refs/heads/$branch"; then
    pushed=1
    break
  fi
  sleep $((attempt * 15))
done

# Forget the snapshot this one replaced, so the kept clone stays small
git reflog expire --expire=now --all
git gc -q --prune=now || true

if [ "$pushed" = 1 ]; then
  echo "Published $(git ls-files | wc -l) file(s) to $branch"
else
  echo "::warning::could not publish the snapshot"
  exit 1
fi
