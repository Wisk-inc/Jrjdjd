# corx-labs.com

The website for **CorX Labs** — an independent AI research lab in Jamaica, and the home of
**CorX1.5** (a 158M-parameter language model, from scratch), **TriStream-SVS** (a
321.8M-parameter singing voice synthesis model, from scratch) and **CorX3.8-27B** (a
27B-parameter Jamaican Patois assistant, fine-tuned from Qwen3.8-27B — and CorX Labs says so
plainly, rather than presenting it as from-scratch work like the other two).

Hand-written static HTML and CSS. No build step, no framework, no npm dependencies. Drop the
folder on any static host and it works — except `/chat/`, which needs two small serverless
functions (`api/search.js`, `api/fetch.js`, both dependency-free) to reach the outside web; see
[CorX Chat](#corx-chat) below.

---

## Structure

```
/                       Home — hero, what this is, products, principles, pipeline, FAQ
/documentation/         The main reference: lab, website, architecture, training, safety, usage
/models/                Our Products — every model released
/models/corx1-5/        CorX1.5 model page (Try it out → Hugging Face)
/models/tristream-svs/  TriStream-SVS model page, with an inline architecture graph
/models/corx3-8/        CorX3.8-27B model page — character, honest fine-tune note, usage
/chat/                  CorX Chat — live chat + browser agent for CorX3.8-27B
/chat/documentation/    Set-up guide: the server code to run, connecting, Agent mode, effort
/blog/                  Blog index
/blog/3-billion-tokens-one-gpu/   Technical breakdown of the training run
/developers/            Who built CorX1.5 — profile and journey
/about/                 About Us — the lab and its founder
/contact/               Contact — lkk89002@gmail.com
/404.html               Not-found page

assets/css/main.css     The entire design system
assets/css/chat.css     CorX Chat's UI — sidebar, dock, tool cards, search animation
assets/js/main.js       Progressive enhancement only — the site works without it
assets/js/chat.js       CorX Chat client: streaming, the agent tool loop, conversations, profile
assets/js/sandbox.js    The real Python VM CorX Chat's agent runs in (CPython via WebAssembly)
assets/vendor/pyodide/  Self-hosted Pyodide build sandbox.js loads
assets/img/             Favicons, app icons, per-page social cards
api/search.js           Edge function — keyless DuckDuckGo search for the agent's web_search tool
api/fetch.js            Edge function — SSRF-guarded URL fetch for the agent's fetch_url tool
tools/                  Script that regenerates every brand image
```

## Design

Taken directly from the CorX mark: a high-contrast old-style serif **C** in espresso brown on warm
textured paper.

| Token | Value |
| --- | --- |
| Paper | `#f4f2ec` |
| Ink | `#211a13` |
| Espresso (brand) | `#3d3025` |
| Display type | Cormorant Garamond |
| UI type | Inter |

Layered glass surfaces (`backdrop-filter` + hairline borders), a fixed paper-grain overlay matching
the logo texture, fluid `clamp()` typography, and a full dark-mode palette that follows the
viewer's system setting. Everything is responsive from 320px up; the nav collapses to a full-screen
sheet on mobile.

## SEO

Everything below is already implemented and live in the files.

**Structured data (JSON-LD)** — one connected `@graph` per page, with stable `@id`s so search
engines and AI systems resolve CorX Labs, Nathan and CorX1.5 as *entities*, not just strings:
`Organization` + `ResearchOrganization`, `Person`, `WebSite`, `WebPage`, `CollectionPage`,
`AboutPage`, `ContactPage`, `ProfilePage`, `TechArticle`, `Blog`, `BlogPosting`, `NewsArticle`,
`SoftwareApplication` + `SoftwareSourceCode`, `Dataset`, `ItemList`, `BreadcrumbList`, `FAQPage`, `ImageObject`, `HowTo`,
and `SpeakableSpecification`.

**Answer-engine optimisation** — every page opens with an `.answer-box`: a self-contained
definition paragraph written to be lifted verbatim into an AI Overview or a chatbot answer. FAQ
blocks target the exact phrasings people search (*"open source AI model Jamaica"*, *"who built
CorX1.5"*, *"where can I download CorX1.5"*) with the answer visible on the page **and** mirrored in
`FAQPage` schema.

**Crawler files**

- `robots.txt` — explicitly allows GPTBot, OAI-SearchBot, ClaudeBot, PerplexityBot,
  Google-Extended, Applebot-Extended, CCBot and friends. Being quotable is the point.
- `sitemap.xml` — with `lastmod`, `hreflang` and image entries.
- `llms.txt` / `llms-full.txt` — the whole site as clean text for AI agents that fetch it.
- `feed.xml` — RSS release feed, discoverable from every page.
- `522b160f9003ae389df5dd38325a824c.txt` — IndexNow key (see below).

**Per-page metadata** — unique title and description, self-referencing canonical,
`hreflang` en + x-default, `max-image-preview:large` and `max-snippet:-1` robots directives (needed
for large previews and AI citations), Open Graph + Twitter cards with **a custom 1200×630 social
image per page**, and `article:modified_time`.

**Performance & Core Web Vitals** — zero JS dependencies, one stylesheet, deferred script, inline
critical background colour to kill the flash of white, `preconnect` to the font hosts,
hover-intent prefetch of internal pages, immutable cache headers on images, and
`prefers-reduced-motion` support.

**Trust signals** — HSTS, CSP, `X-Content-Type-Options`, `Referrer-Policy` and `Permissions-Policy`
in `_headers` / `netlify.toml` / `vercel.json`; a real 404 page; skip link, focus-visible outlines,
ARIA labels and semantic landmarks throughout.

**Content that targets real questions** — the blog post is written against searches like *"train
a language model on one GPU"*, *"how much VRAM to train a 158M model"* and *"how big is 3 billion
tokens on disk"*, with the answer stated plainly in the first paragraph of each section and
mirrored in `FAQPage` markup. The `/developers/` page carries `ProfilePage` + `Person` markup,
which is what search engines read for author identity and E-E-A-T.

**Diagrams are inline SVG, not images** — the TriStream-SVS architecture graph is drawn with the
same CSS tokens as the rest of the site, so it themes with light/dark, stays crisp at any zoom,
costs no extra request, and its labels are real text that crawlers and screen readers can read. It
scales to the container and scrolls horizontally below ~900px rather than shrinking to illegible.

**Internal linking** — a hub-and-spoke cluster: `/models/` is the hub, `/models/corx1-5/` is the
spoke, and `/documentation/` deep-links into both with descriptive anchor text. `_redirects` catches
the URLs people guess (`/docs`, `/corx1.5`, `/products`) so no link equity leaks.

---

## CorX Chat

`/chat/` is a real browser chat and agent for CorX3.8-27B — not a proxy through CorX Labs'
infrastructure. The model runs on **the user's own server** (a GPU notebook printing an
OpenAI-compatible endpoint, keyless, CORS enabled per `chat/documentation/`'s server code), and the
browser calls that endpoint **directly**. Because that URL is an ephemeral Cloudflare quick tunnel
that changes on every restart, it lives in a Settings dialog and `localStorage`, not in the code.

**Agent mode is a text protocol, not native tool-calling.** The server is a plain completions
endpoint, so `assets/js/chat.js` teaches the model a small format in the system prompt
(`<tool>{"name": ..., "arguments": {...}}</tool>`) and parses it out of the streamed reply. Every
tool call actually executes — nothing is simulated:

- `run_python` / `write_file` / `read_file` / `delete_file` / `list_files` / `install_packages` /
  `deliver_file` run in a real Python sandbox in the tab (`assets/js/sandbox.js`, CPython compiled
  to WebAssembly via the vendored Pyodide build). Its own Terminal panel shows every command and
  its real output, including real tracebacks — and if `run_python` fails, the actual traceback is
  fed back to the model on the next round so it can fix its own code, which is the whole "auto-fix"
  mechanism: the existing multi-round tool loop, not a special path.
- `web_search` and `fetch_url` call `/api/search` and `/api/fetch` — two dependency-free Vercel
  edge functions (DuckDuckGo HTML scraping and an SSRF-guarded proxy) that exist so the browser is
  not CORS-blocked reaching arbitrary sites. No key, no quota.
- `search_memory` greps the user's other saved conversations in `localStorage` — real keyword
  search over what's in the browser, not a hidden server-side record.
- `set_plan` / `complete_step` publish a checklist the Plan panel renders as live state.

**Effort (Low → Max) changes real request parameters** — `max_tokens`, how many tool-call rounds
the agent gets before it must stop, how many search results it pulls, and how strongly the system
prompt tells it to think, verify and re-search. See the `EFFORT` table at the top of `chat.js`.

**State that survives a refresh, honestly.** Conversations, the plan, the agent toggle, effort,
profile and the endpoint config all persist in `localStorage` (key `corx.chat.v3`). The Python
sandbox does **not** — it's in-memory WebAssembly, gone when the tab reloads — so the auto-resume
prompt that fires after an interrupted run tells the model exactly that, instructing it to
`list_files` and recheck rather than assume anything survived.

**Deploying the API** — `api/search.js` and `api/fetch.js` need a serverless host; Vercel's is what
`vercel.json` configures (clean URLs, `/api/(.*)` → `no-store`, the CSP's `connect-src` allowing
`https://*.trycloudflare.com` and `img-src` allowing `https://icons.duckduckgo.com` for source
favicons). Netlify/Cloudflare Pages serve the static pages fine but won't run the two functions
without their own equivalent — without them, plain chat still works (the browser talks to the
model endpoint directly), only Agent mode's search tools go missing.

---

## Deploying

The site is plain static files. Point any of these at the repository root:

**Netlify / Cloudflare Pages** — connect the repo, publish directory `.`, no build command.
`netlify.toml`, `_headers` and `_redirects` are picked up automatically.

**Vercel** — import the repo, framework preset "Other". `vercel.json` handles clean URLs, redirects
and headers.

**GitHub Pages** — Settings → Pages → deploy from branch, root. `CNAME` and `.nojekyll` are already
in place.

Then, in your registrar's DNS, point `corx-labs.com` at the host and set `www` to redirect to the
apex (the redirect rules assume apex is canonical).

## After it's live — do these in order

1. **Google Search Console** — add `corx-labs.com` as a *domain* property, verify by DNS TXT record,
   submit `https://corx-labs.com/sitemap.xml`, then use **URL Inspection → Request indexing** on the
   homepage and the CorX1.5 page.
2. **Bing Webmaster Tools** — add the site (you can import straight from Search Console) and submit
   the same sitemap. Bing feeds ChatGPT search, so this matters more than it used to.
3. **IndexNow** — the key file is already deployed. Ping it whenever you publish or update a page:
   ```
   curl "https://api.indexnow.org/indexnow?url=https://corx-labs.com/models/corx1-5/&key=522b160f9003ae389df5dd38325a824c"
   ```
4. **Link back from Hugging Face.** This is the single highest-value thing you can do. Add
   `https://corx-labs.com` to the CorX1.5 model card and to your Hugging Face profile. Search
   engines learn that *CorX1.5 → corx-labs.com* mostly from links on pages that already rank, and
   your Hugging Face page is exactly that.
5. **Be consistent everywhere.** Use the same name (*CorX Labs*), the same logo, and the same
   one-line description on Hugging Face, GitHub, and anywhere else you post. Entity recognition is
   built on repetition across sources.
6. **Validate the markup** — [Rich Results Test](https://search.google.com/test/rich-results) and
   [Schema Markup Validator](https://validator.schema.org/) on each URL.
7. **Check the figures in the blog post before you promote it.** Everything derived from published
   specs is exact — the 2.52 GB of fp32 model and optimiser state at 157.8M parameters, the 6 GB
   `uint16` token file, the ~5,722 optimiser steps. The worked example (micro-batch 8, 64
   accumulation steps) and the throughput table are labelled as illustrations, not as a log of your
   run. If your real numbers differ, swap them in — real numbers are more interesting anyway.
8. **Keep `lastmod` honest.** When you change a page, update its `<lastmod>` in `sitemap.xml`, the
   `dateModified` in that page's JSON-LD, and re-ping IndexNow.

## Regenerating brand images

```bash
pip install pillow
curl -L -o cormorant.ttf \
  "https://raw.githubusercontent.com/google/fonts/main/ofl/cormorantgaramond/CormorantGaramond%5Bwght%5D.ttf"
python3 tools/generate-brand-assets.py   # expects cormorant.ttf beside it
```

Regenerates every favicon, app icon, the wordmark and all six social cards from the same source of
truth, so the brand never drifts.

---

© CorX Labs. Models released under the Apache 2.0 licence.
