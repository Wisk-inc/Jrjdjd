# Scam Finder

Give it one suspicious link. It works out what the site is, then finds the other sites run by the same operation and draws the whole thing as a map.

It was built around a real case: a WhatsApp message promising a "National Heroes' Day gift" from a well-known Jamaican brand. One search on a file that page served led to more than 250 sibling domains running the same kit, with lures aimed at a dozen countries.

```bash
node scam-finder/cli.js investigate "https://suspicious.example/abc?s=wa" --html map.html
```

It needs Node 20 or newer and nothing else: no install step, no API keys.

There are two halves:

- **Investigate** starts from one link and maps what it is connected to. Minutes, on demand.
- **[Radar](#radar-scanning-that-never-stops)** never stops. It keeps an index of over 18 million domains, watches the suspicious ones, and records when each changes or is taken down. (Radar needs Node 22.5+, for the SQLite built into Node.)

## What it does

1. **Profiles the link.** Fetches the page as plain text (nothing is rendered or run) and reads what its scripts do: device cloaking, spoofed link previews, hidden redirects. Adds DNS, hosting, registration date and registrar, certificates, and whether public blocklists already list it.
2. **Finds what makes it distinctive.** Kit files at unusual paths, byte-identical images, the exact page title, a dedicated server, shared certificates, tracking IDs.
3. **Searches for the same fingerprints elsewhere**, mainly in the [urlscan.io](https://urlscan.io) archive of scanned pages. A fingerprint that matches thousands of sites is thrown away as too common to mean anything.
4. **Visits a sample of what it found**, to see which sites are still up and what they are showing today.
5. **Scores every site** from 0 to 100, keeping each reason alongside the number, and groups sites into campaigns (same lure) and shared infrastructure (same kit file, same registration day, same nameserver pair).
6. **Reads the code.** Each page's HTML and JavaScript is analysed as text, never run. Encoded layers (base64, URL-escapes, character codes, hex strings) are peeled off first, so behaviour hidden inside them is found and flagged as hidden. It looks for 23 behaviours: credentials sent to a Telegram bot or Discord webhook, wallet-draining approvals, recovery-phrase forms, card skimmers, commands copied to the clipboard, fake updates, browser miners, invisible frames, page-locking tricks, scanner detection and more.
7. **Draws the map**: one self-contained HTML file with a 3D globe you can turn, a flat tree, a network view, and the evidence for every site.

## Using it

```bash
# Investigate a link (about 30 seconds to 4 minutes, depending on how much it finds)
node scam-finder/cli.js investigate "<url or domain>"

# Go wider: search again from every campaign found, and visit every site
node scam-finder/cli.js investigate "<url>" --deep --html map.html --out result.json

# Just score one link, no searching
node scam-finder/cli.js investigate "<url>" --depth 0

# Collect fresh leads by theme, with no starting link
node scam-finder/cli.js hunt jamaica
node scam-finder/cli.js hunt lottery whatsapp-giveaway --html leads.html
node scam-finder/cli.js hunt --query 'page.title:"claim your prize"' --keyword jncb

# Re-render a saved result
node scam-finder/cli.js report result.json --md report.md
```

`node scam-finder/cli.js help` lists every option. Defanged input (`hxxps://example[.]com`) is accepted everywhere, so indicators can be pasted straight from a report.

Three ways to read a result:

| Flag | Output |
| --- | --- |
| _(none)_ | A readable summary on stdout |
| `--json` | The complete result |
| `--compact` | A short JSON digest, sized to fit in a language model's context |

`--out`, `--html` and `--md` save files as well, whichever view is printed.

### For AI agents

There are three ways in, all returning the same data.

**MCP server.** `scam-finder/mcp-server.js` speaks the Model Context Protocol over stdio with no dependencies. The repository's `.mcp.json` registers it, so Claude Code offers the tools as soon as it opens this folder. For any other client:

```json
{ "mcpServers": { "scam-finder": { "command": "node", "args": ["scam-finder/mcp-server.js"] } } }
```

| Tool | What it does |
| --- | --- |
| `investigate_url` | Profile a link and map what it is connected to |
| `hunt_scams` | Collect leads from profiles, queries or keywords |
| `get_domain_details` | Read the full record for any domain in a saved result |
| `render_report` | Write the HTML map or a Markdown report |
| `list_hunt_profiles` | Describe the saved hunts |
| `radar_status`, `radar_sites`, `radar_site`, `radar_events` | Query the Radar database |
| `radar_scan`, `radar_ingest` | Run scan cycles, or load more names into the index |
| `contact_lookup` | Describe an email address or phone number a scam uses |

Each run saves the full result and the map to disk and replies with a digest, so a large investigation never floods the conversation.

**Command line.** `--compact` prints the same digest as JSON. Progress goes to stderr, results to stdout.

**HTTP.** With the web-check server running (`node server`):

```
GET /api/scam-finder?url=<link>&depth=1
```

This uses smaller limits so that it answers within the server's request timeout. The map itself is served at `/scam-finder/`, where it takes a link, calls the API and draws the result.

**Claude Code skill.** `.claude/skills/scam-finder` teaches Claude when to reach for the tool and how to report what it finds.

When a Radar database exists, `investigate` uses it automatically: every copy of the seed's kit that Radar has confirmed joins the map, without being fetched again.

## Radar: scanning that never stops

```bash
node scam-finder/cli.js radar ingest all     # build the index: about 5 minutes, 750 MB
node scam-finder/cli.js radar run            # scan forever, one cycle a minute
node scam-finder/cli.js radar status         # how it is going
```

`ingest all` loads five public datasets into one SQLite file:

| Source | Names | What it adds |
| --- | --- | --- |
| Common Crawl web graph | 15,000,000 | The established web, each domain with its rank in the link graph |
| Tranco | 1,000,000 | The most-visited domains, with a traffic rank |
| Blocklists | about 1,200,000 | Names already reported as scams or phishing |
| Newly registered domains | about 2,000,000 | Everything registered in the last 30 days |
| Certificate Transparency | live | Hostnames from TLS certificates issued minutes ago |

That comes to more than 18 million domains. Then every cycle, `run`:

1. reads the newest certificates from the public logs (about 5,000 hostnames a cycle by default),
2. scores every new name from its spelling alone,
3. puts the most suspicious unvisited names on the watchlist,
4. visits the watched sites that are due, analyses their code, and
5. writes down what changed.

```bash
node scam-finder/cli.js radar sites --state live --query airtel
node scam-finder/cli.js radar site some-domain.buzz      # full record and history
node scam-finder/cli.js radar events --types taken-down
node scam-finder/cli.js radar batches                    # bulk-registration moulds
node scam-finder/cli.js radar map --html radar.html      # the watchlist as a 3D map
node scam-finder/cli.js radar contact "+1 876 555 0142"
```

`radar help` lists everything. The server exposes the same data read-only at `/api/scam-radar?view=status|map|sites|site|events`, and the page at `/scam-finder/?radar` draws the live map and refreshes it every minute.

### How it copes with millions of sites on a small machine

Fetching 16 million pages a day would take about 185 requests a second and hundreds of gigabytes. Radar never does that. It is a funnel, and each stage is far cheaper than the next:

1. **Names cost nothing.** Every name is scored from its spelling in about a microsecond: borrowed brand names, bait words, cheap endings, machine-made labels. The whole 18 million takes seconds, with no network at all.
2. **The database does the bookkeeping.** A row is a name and four small numbers (38 bytes). The triage score is a column SQLite computes itself, and only rows scoring 50 or more are indexed, so "what should I visit next" is instant and memory stays near 64 MB.
3. **Batches give themselves away.** Throwaway scam domains are registered by script, so they share a mould: five random letters and `.buzz`, say. For every mould, Radar compares how common it is among brand-new names with how common it is across the established web. One that is suddenly a hundred times over-represented, and mostly unpronounceable, is a batch. This finds sites no scanner has visited and no blocklist has listed, using nothing but arithmetic on names.
4. **DNS before HTTP.** A dead site is settled by one DNS answer of a few hundred bytes. Only sites that still resolve are fetched.
5. **A kit's front door is its signature.** Many kits answer `/` with a tell-tale stub. One tiny request confirms a copy, and (for kits that show their lure on any path) a second reads what it is promoting today.
6. **Checks are rationed by risk.** Live high-risk sites are revisited every 30 minutes to 2 hours, dull ones every few days, dead ones on a doubling back-off. The cost follows the watchlist, not the index.
7. **Fingerprints, not copies.** A page is stored as two 64-bit hashes (its skeleton and its wording), which is enough to detect change and to recognise clones of the same kit.

How much it reads is a dial: `--checks` (visits per cycle, default 150, about 216,000 a day) and `--ct-tiles` (certificates per cycle). On the test run that built this, the batch detector flagged 221 moulds among two million new registrations, and visiting one of them confirmed over 600 live copies of a single scam kit, most of them unknown to any scanner.

### What it tracks for each watched site

- **State and uptime**: live, offline, not serving, flagged by its host, suspended, seized or parked, and the share of visits that found it up.
- **Takedowns**: when a site that was up stops answering twice running, Radar records the window it went down in (after the last good visit, before the first bad one) and why: gone from DNS, registration deleted, held by the registrar, flagged by its host.
- **Changes**: a new lure, a rebuilt page, reworded content, a move to another server, new nameservers, a kit appearing, a new blocklist entry. Each is a dated event.
- **Rank**: position in the link graph and in the traffic top list, where it has one.
- **Hosting**: address, network and country. Behind Cloudflare and similar networks the real server location is hidden, and Radar says so rather than guess.
- **Search presentation**: title, description, canonical link, whether it hides from search engines, structured data.
- **Contact points**: emails, phone numbers, WhatsApp and Telegram handles, and wallets published on the page, used to tie sites together.

Two things nobody outside can measure, so Radar does not pretend to:

- **How many people clicked.** Visitor counts belong to the site's operator. Rank is the honest public proxy: a site in the traffic top list is being visited; one outside the top 15 million of the link graph is reaching people some other way, such as chain messages.
- **Who is behind a site.** Radar maps infrastructure. It does not identify people.

### Contact points

`radar contact <email or phone>` reads what the contact says about itself: whether an email is free webmail, a throwaway or on its own domain; which country and numbering range a phone number belongs to, with the regulator warning attached to callback-scam area codes; and which watched scam sites publish it.

With `--online` it also asks StopForumSpam whether the address has been reported, and Have I Been Pwned which breaches include it (set `HIBP_API_KEY`; breach names and dates only). It never retrieves leaked passwords or personal records, and there is no breach lookup for phone numbers because no public service offers one. A contact on a scam page is often a hijacked or throwaway account, so treat the result as a lead about the scam, not as someone's identity.

## Where the data comes from

Everything is public, free and needs no key.

| Source | Used for |
| --- | --- |
| The target site itself | Page content, scripts, redirects, kit signatures |
| [urlscan.io](https://urlscan.io) search | Finding other sites that served the same files, titles or addresses |
| DNS over HTTPS (Google, Cloudflare) | Addresses and nameservers, from networks that block raw DNS |
| Team Cymru | Which network an address belongs to |
| RDAP | Registration date, registrar, abuse contact |
| Cert Spotter, crt.sh | Certificates, and domains sharing one |
| ip.thc.org | Other domains on a dedicated server |
| Blocklists | OpenPhish, phishunt.io, Global Anti-Scam Org, CERT Polska, Phishing.Database and more (`cli.js feeds`) |
| [Common Crawl](https://commoncrawl.org) web graph, [Tranco](https://tranco-list.eu) | Radar: the ranked index of established domains |
| Certificate Transparency logs, newly-registered-domain lists | Radar: the live feed of new names |

Optional environment variables:

| Variable | Effect |
| --- | --- |
| `URLSCAN_API_KEY` | Searches further back than 30 days, with higher rate limits |
| `CERTSPOTTER_TOKEN` | Higher Certificate Transparency limits |
| `SCAM_FINDER_CACHE_DIR` | Where lookups are cached (default: the system temp directory) |
| `SCAM_FINDER_NO_CACHE` | Set to disable the cache |
| `SCAM_FINDER_OUT_DIR` | Where the MCP server saves results |
| `SCAM_FINDER_DB` | Radar's database file (default `~/.scam-finder/radar.db`) |
| `SCAM_FINDER_DB_CACHE_MB` | Memory SQLite may use for its page cache (default 64) |
| `HIBP_API_KEY` | Enables breach-exposure checks in `radar contact --online` |
| `NODE_USE_ENV_PROXY=1` | Makes Node honour `HTTPS_PROXY` |

Lookups are cached on disk for between 30 minutes and a week depending on how fast they go stale, and every service is rate-limited per host, so repeat runs are quick and polite.

## How to read a score

A score adds up independent pieces of evidence. Each has a weight, and they combine so that several weak signals count for something without any one of them being decisive.

| Level | Score | Read it as |
| --- | --- | --- |
| Critical | 85 to 100 | Strong direct evidence: a known kit, a blocklist entry, cloaking plus a borrowed brand |
| High | 65 to 84 | Several signals agree |
| Medium | 40 to 64 | Worth a look |
| Low | under 40 | Little or nothing against it |

**A score is a reason to look, not a verdict.** A site found by a search still has to earn its score on its own evidence, and links to a seed count for less when the seed itself looks innocent. Long-established domains are discounted. Low does not mean safe: it means nothing was found.

Things that will mislead it:

- **Shared infrastructure.** Sites behind Cloudflare or on big clouds share addresses with strangers, so those are never used as links. Nameserver pairs and same-day registration are shown as weak links for the same reason.
- **The 30-day window.** Without a urlscan.io key, only sites scanned in the last 30 days can be found.
- **Cloaking.** A site that shows scanners a blank page may be missed, or look harmless.
- **Hunts.** Profile searches return candidates. Many are honest sites that matched a word in a title.

## Hunt profiles

`cli.js profiles` lists them: `jamaica`, `whatsapp-giveaway`, `lottery`, `bank-phishing`, `delivery`, `crypto`, `tech-support`, `government-benefit`.

The `jamaica` profile looks for pages that borrow Jamaican brands (banks, telecoms, utilities, government agencies), pages pairing "Jamaica" with prize or sign-in wording, holiday giveaway lures, and copies of the WhatsApp gift kit whose lure is aimed at Jamaica. No site is treated as suspect for being Jamaican, or for where it is hosted. Leads come from what a page claims to be.

## Extending it

All of the knowledge lives in three data files, written to be edited:

- `data/signatures.js`: fingerprints of scam kits. Add one when you meet a new kit: a few odd markers and, if you know one, a search that finds more copies.
- `lib/analyzer.js`: the code-analysis rules. Each is a name, a severity and a pattern; add one for any behaviour you want flagged.
- `data/brands.js`: brands that scams borrow, with the domains the real organisations use.
- `data/profiles.js`: saved hunts.

Blocklist feeds are in `lib/sources/feeds.js`. A new data source is one module in `lib/sources/` plus a call from `lib/investigate.js`. Radar's bulk sources are in `lib/radar/ingest.js`; if you have access to registry zone files, adding them there gives the batch detector every new name rather than a sample.

```bash
node --test "scam-finder/test/*.test.js"   # offline, about five seconds
node scam-finder/cli.js build-viewer       # after editing scam-finder/viewer/
```

The tests run against a canned network, so they never go online. The viewer's sources are in `viewer/`; `build-viewer` assembles them into `public/scam-finder/index.html`, the page the server hosts.

## Safety

- **Read-only.** It makes ordinary GET requests and reads public records. It never submits forms, logs in, or probes for weaknesses.
- **Suspect pages are treated as hostile.** Bodies are size-capped and parsed as text. Redirects are followed by hand, and every hop is refused if it points at a private, loopback or link-local address. That check resolves the name through public DNS just before each request, which stops ordinary cases; if you expose the API on a network with sensitive internal services, also restrict the server's outbound access.
- **No personal data.** Registrant names, emails and addresses are dropped when registration records are parsed. Only registrar, dates, organisation and country are kept. Contact points are recorded only when a suspect page itself publishes them.
- **Polite.** Every service is rate-limited per host, and Radar's per-cycle limits bound how much it fetches however large the index grows.
- **Indicators are defanged** (`hxxps://example[.]com`) in every report, and the map never links to a suspect site.

If a site is a scam, report it where it can be acted on: the registrar's abuse contact (shown for each domain), [Google Safe Browsing](https://safebrowsing.google.com/safebrowsing/report_phish/), and the hosting provider. If you have lost money, contact your bank and the police.
