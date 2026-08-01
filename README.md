# corx-labs.com

The website for **CorX Labs** — an independent AI research lab in Jamaica, and the home of
**CorX1.5**, a 158M-parameter open-source language model built from scratch.

Hand-written static HTML and CSS. No build step, no framework, no dependencies. Drop the folder on
any static host and it works.

---

## Structure

```
/                       Home — hero, what this is, products, principles, pipeline, FAQ
/documentation/         The main reference: lab, website, architecture, training, safety, usage
/models/                Our Products — every model released
/models/corx1-5/        CorX1.5 model page (Try it out → Hugging Face)
/about/                 About Us — the lab and its founder
/contact/               Contact — lkk89002@gmail.com
/404.html               Not-found page

assets/css/main.css     The entire design system
assets/js/main.js       Progressive enhancement only — the site works without it
assets/img/             Favicons, app icons, per-page social cards
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
`AboutPage`, `ContactPage`, `TechArticle`, `SoftwareApplication` + `SoftwareSourceCode`, `Dataset`,
`ItemList`, `BreadcrumbList`, `FAQPage`, and `SpeakableSpecification`.

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

**Internal linking** — a hub-and-spoke cluster: `/models/` is the hub, `/models/corx1-5/` is the
spoke, and `/documentation/` deep-links into both with descriptive anchor text. `_redirects` catches
the URLs people guess (`/docs`, `/corx1.5`, `/products`) so no link equity leaks.

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
7. **Keep `lastmod` honest.** When you change a page, update its `<lastmod>` in `sitemap.xml`, the
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
