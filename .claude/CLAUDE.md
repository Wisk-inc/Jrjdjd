# CorX Labs site: notes for Claude Code

## House style for everything written here

Pages, release notes, feed items, llms.txt, blog posts and X posts all follow this. Nathan's own voice is short
and direct; the site should read the same way.

- **Short, plain sentences.** Say the thing. Numbers beat adjectives.
- **No em dashes in prose.** Use a comma, a colon, a full stop or brackets. Page titles keep the
  "Name — subtitle" form.
- **Don't praise the writing.** No "stated plainly", "honest about", "we say so plainly", "the honest answer".
  State the limit and move on. ("Honest" is fine as a model behaviour, e.g. CorX3.8's register.)
- **No "not just X, but Y"** and no "It's not X, it's Y".
- **Avoid these words:** delve, tapestry, testament, pivotal, underscore, showcase, seamless, robust, landscape,
  realm, crucial, vibrant, foster, enhance, meticulous, boast, groundbreaking, renowned, additionally,
  moreover, furthermore, "in summary", "it is important to note".
- **No trailing "-ing" clauses** that add significance ("…, highlighting how…").
- **Bold sparingly**, headings in sentence case.
- **Every claim from the project's own docs or benchmark files**, with losses next to wins.

Run `python3 tools/style-check.py` before committing; it lists what to fix.

## Release workflow

- Work on the session's `claude/...` branch, then merge into `main` with `git merge --no-ff` and push.
- Page titles don't change.
- FAQ answers must match their FAQPage JSON-LD text exactly.
- Check pages in a browser under the CSP in `_headers`, at 360, 390 and 1440 px, in light and dark.
- `models/pluvium/index.html` is generated: edit `tools/build-pluvium-page.py` and `tools/pluvium_scorecard.py`,
  then run `python3 tools/build-pluvium-page.py`. Benchmark pages come from `tools/build-benchmarks.py`.
