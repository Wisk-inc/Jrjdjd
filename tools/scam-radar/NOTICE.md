# Scam Radar: where this code comes from

`scam-finder/` is Scam Finder by CorX Labs, copied unchanged from the `scam-finder/` folder of
[Wisk-inc/web-check](https://github.com/Wisk-inc/web-check), branch `claude/sweet-lamport-29tl0k`, as of merge
commit `3348521` (which includes Scam Finder's commit `8930c22`; tests left out). That repository is a fork of [Web-Check](https://github.com/lissy93/web-check) by
Alicia Sykes, under the MIT licence in `LICENSE` here.

`world-110m.json` is Natural Earth's 1:110m countries (public domain), as shipped with Web-Check.
`iso3-to-iso2.json` and `country-names.json` were generated from ISO 3166 with `pycountry`.

To update Scam Finder, copy the folder again from the newer commit and note it above.

What was added around it for this site:

- `export.mjs` turns Radar's database into the published files (the snapshot, a status file, the per-site lookup
  and the map), and with `sanitize.mjs` decides what may be published.
- `prioritize.mjs` puts new brand look-alikes at the front of Radar's queue, through Radar's own `watch`.
- `hunt-jamaica.mjs` runs Scam Finder's `hunt` with its `jamaica` and `lottery` profiles once an hour, while the
  scan runs, and puts the suspicious leads on Radar's watchlist through `watch`. `export.mjs` publishes counts.
- `publish.sh` pushes the files to the `scam-radar-data` branch as one commit.
- `api-core.mjs` is Scam Finder's `investigate` as an API (`depth=2` is the deep dive), plus its `describeContact`
  for `?contact=`, with `api-vercel.cjs` and `api-netlify.cjs` as the wrappers. It checks every address the
  function connects to, redirects included, and refuses private and local ones. `browser-entry.mjs` is the offline name and link logic for the browser. `build-bundles.mjs` builds all
  three into `/api/scam-finder.js`, `/netlify/functions/scam-finder.js` and `/assets/js/scam-finder-core.js`.
  `shims/` stands in for two Node modules in the browser bundle.
- `../build-scam-radar-page.py` builds `/scam-radar/`; `assets/js/scam-radar.js` draws the data and runs the
  link checker.
- `../build-scam-map-page.py` builds `/scam-radar/map/` from `scam-finder/viewer/`. The viewer's script and
  stylesheet are copied unedited; `assets/js/scam-map-boot.js` points its two requests at this site and drops the
  viewer's `?api=` and `?radar-api=` parameters, so a crafted link cannot show another server's answers here.
- `/api/scam-radar-status.js` (Vercel edge function) says which commit the `scam-radar-data` branch points to now
  and returns that commit's status file. Read by branch name, raw.githubusercontent.com can lag a push by
  minutes; the page and the map read files at that commit instead.
- `.github/workflows/scam-radar.yml` scans in one-minute cycles around the clock and publishes after every cycle.
  Each 55-minute run starts the next; `scam-radar-keepalive.yml` starts it again if that chain stops.

`scam-finder/` itself is unchanged.
