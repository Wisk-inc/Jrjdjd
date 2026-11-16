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
- `publish.sh` pushes the files to the `scam-radar-data` branch as one commit.
- `api-core.mjs` is Scam Finder's `investigate` as an API, with `api-vercel.cjs` and `api-netlify.cjs` as the
  wrappers. `browser-entry.mjs` is the offline name and link logic for the browser. `build-bundles.mjs` builds all
  three into `/api/scam-finder.js`, `/netlify/functions/scam-finder.js` and `/assets/js/scam-finder-core.js`.
  `shims/` stands in for two Node modules in the browser bundle.
- `../build-scam-radar-page.py` builds `/scam-radar/`; `assets/js/scam-radar.js` draws the data and runs the
  link checker.
- `../build-scam-map-page.py` builds `/scam-radar/map/` from `scam-finder/viewer/`. The viewer's script and
  stylesheet are copied unedited; `assets/js/scam-map-boot.js` points its two requests at this site.
- `.github/workflows/scam-radar.yml` runs the scans and publishes after every five cycles.

`scam-finder/` itself is unchanged.
