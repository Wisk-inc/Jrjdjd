# Scam Radar: where this code comes from

`scam-finder/` is Scam Finder by CorX Labs, copied unchanged from the `scam-finder/` folder of
[Wisk-inc/web-check](https://github.com/Wisk-inc/web-check), branch `claude/sweet-lamport-29tl0k`, as of merge
commit `3348521` (which includes Scam Finder's commit `8930c22`; tests left out). That repository is a fork of [Web-Check](https://github.com/lissy93/web-check) by
Alicia Sykes, under the MIT licence in `LICENSE` here.

`world-110m.json` is Natural Earth's 1:110m countries (public domain), as shipped with Web-Check.
`iso3-to-iso2.json` and `country-names.json` were generated from ISO 3166 with `pycountry`.

To update Scam Finder, copy the folder again from the newer commit and note it above.

- `export.mjs` turns Radar's database into `scam-radar.json` and decides what may be published.
- `../build-scam-radar-page.py` builds `/scam-radar/`; `assets/js/scam-radar.js` draws the data.
- `.github/workflows/scam-radar.yml` runs the scans every three hours and publishes the snapshot to the
  `scam-radar-data` branch.
