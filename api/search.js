/* GET|POST /api/search?q=… — real web search.

   No API key, no per-user quota: most of these are scraped public search
   result pages, which puts this at the mercy of whichever engine's bot
   detection is in a mood that day — a real browser header set and a GET
   (see BROWSER_HEADERS) gets past the header-based checks, but a
   server-to-server fetch from a datacenter IP can still get silently
   served a CAPTCHA/consent page with a 200 status and no real results,
   which no amount of header-tweaking fixes. So this tries five sources in
   order and returns the first that actually parses results: Google News'
   RSS feed first (a syndication endpoint, not a scraped results page, so
   it isn't fighting the same anti-bot layer — and it is a good match for
   "what's new" / "news today" style queries specifically), then two
   DuckDuckGo mirrors, DuckDuckGo Lite, then Bing. */

export const config = { runtime: 'edge' };

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
  });

const decode = (s) =>
  String(s)
    .replace(/<[^>]*>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&middot;/g, '·')
    .replace(/&mdash;/g, '—')
    .replace(/&ndash;/g, '–')
    .replace(/&#x2F;/g, '/')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/\s+/g, ' ')
    .trim();

/* DuckDuckGo wraps outbound links as /l/?uddg=<encoded>. */
const unwrap = (href) => {
  try {
    if (href.startsWith('//')) href = `https:${href}`;
    const u = new URL(href, 'https://duckduckgo.com');
    const target = u.searchParams.get('uddg');
    return target ? decodeURIComponent(target) : u.toString();
  } catch {
    return href;
  }
};
const domainOf = (url) => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; } };

/* Attribute order in these pages isn't something to trust (href before
   class, or after — both show up across DDG's templates), so anchors are
   matched generically and then filtered/read by attribute name rather than
   by a fixed href-then-class or class-then-href sequence. */
function anchorsWithClass(html, tag, classNeedle) {
  const out = [];
  const re = new RegExp(`<${tag}\\b([^>]*)>([\\s\\S]*?)<\\/${tag}>`, 'g');
  const classRe = new RegExp(`class="[^"]*${classNeedle}[^"]*"`);
  const hrefRe = /href="([^"]+)"/;
  let m;
  while ((m = re.exec(html))) {
    const attrs = m[1];
    if (!classRe.test(attrs)) continue;
    const hrefM = attrs.match(hrefRe);
    out.push({ href: hrefM ? hrefM[1] : '', inner: m[2] });
  }
  return out;
}

/* html.duckduckgo.com and duckduckgo.com/html serve the identical template:
   result__a for the link, result__snippet for the summary. */
export function parseDdgHtml(html, limit) {
  const out = []; const seen = new Set();
  const links = anchorsWithClass(html, 'a', 'result__a');
  const snippets = anchorsWithClass(html, 'a', 'result__snippet').map((a) => decode(a.inner));
  links.forEach((a, i) => {
    if (out.length >= limit) return;
    const url = unwrap(a.href); const title = decode(a.inner);
    if (!title || !/^https?:/i.test(url) || seen.has(url)) return;
    seen.add(url);
    out.push({ title, url, domain: domainOf(url), snippet: snippets[i] || '' });
  });
  return out;
}

/* lite.duckduckgo.com is a plainer, table-based page with different classes
   — less commonly fronted by the same anti-bot layer as the main site. */
export function parseDdgLite(html, limit) {
  const out = []; const seen = new Set();
  const links = anchorsWithClass(html, 'a', 'result-link');
  const sre = /<td[^>]*class="[^"]*result-snippet[^"]*"[^>]*>([\s\S]*?)<\/td>/g;
  const snippets = []; let sm;
  while ((sm = sre.exec(html))) snippets.push(decode(sm[1]));
  links.forEach((a, i) => {
    if (out.length >= limit) return;
    const url = unwrap(a.href); const title = decode(a.inner);
    if (!title || !/^https?:/i.test(url) || seen.has(url)) return;
    seen.add(url);
    out.push({ title, url, domain: domainOf(url), snippet: snippets[i] || '' });
  });
  return out;
}

/* Google News' RSS feed — a real syndication endpoint meant for feed
   readers, not the human search page, so it doesn't hit the same
   CAPTCHA/consent wall. <link> is Google's own redirect through the item,
   not the original article, so the <source url> — the actual outlet's own
   domain — drives the favicon/domain instead of the redirect host. */
export function parseGoogleNewsRss(xml, limit) {
  const out = []; const seen = new Set();
  const unwrapCdata = (s) => String(s).replace(/^<!\[CDATA\[/, '').replace(/\]\]>$/, '');
  const items = xml.match(/<item>[\s\S]*?<\/item>/g) || [];
  for (const item of items) {
    if (out.length >= limit) break;
    const titleM = item.match(/<title>([\s\S]*?)<\/title>/);
    const linkM = item.match(/<link>([\s\S]*?)<\/link>/);
    if (!titleM || !linkM) continue;
    const title = decode(unwrapCdata(titleM[1]));
    const url = unwrapCdata(linkM[1]).trim();
    if (!title || !/^https?:/i.test(url) || seen.has(url)) continue;
    const sourceM = item.match(/<source url="([^"]+)"[^>]*>([\s\S]*?)<\/source>/);
    const domain = (sourceM && domainOf(sourceM[1])) || domainOf(url);
    const descM = item.match(/<description>([\s\S]*?)<\/description>/);
    seen.add(url);
    out.push({ title, url, domain, snippet: descM ? decode(unwrapCdata(descM[1])) : '' });
  }
  return out;
}

/* Last resort: Bing's plain HTML results page. */
export function parseBing(html, limit) {
  const out = []; const seen = new Set();
  const blocks = html.match(/<li class="b_algo"[\s\S]*?<\/li>/g) || [];
  for (const block of blocks) {
    if (out.length >= limit) break;
    const linkM = block.match(/<h2>\s*<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
    if (!linkM) continue;
    const url = linkM[1]; const title = decode(linkM[2]);
    if (!title || !/^https?:/i.test(url) || seen.has(url)) continue;
    seen.add(url);
    const snipM = block.match(/<p>([\s\S]*?)<\/p>/);
    out.push({ title, url, domain: domainOf(url), snippet: snipM ? decode(snipM[1]) : '' });
  }
  return out;
}

/* A plain server-side fetch with no user-agent reads as a bot to every one
   of these and gets 403'd. A real desktop-browser header set, and a GET
   (what the page itself issues), gets through far more reliably. */
const BROWSER_HEADERS = {
  'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'accept-language': 'en-US,en;q=0.9',
  referer: 'https://duckduckgo.com/'
};

const ENGINES = [
  { url: (q) => `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=en-US&gl=US&ceid=US:en`, parse: parseGoogleNewsRss },
  { url: (q) => `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`, parse: parseDdgHtml },
  { url: (q) => `https://duckduckgo.com/html/?q=${encodeURIComponent(q)}`, parse: parseDdgHtml },
  { url: (q) => `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(q)}`, parse: parseDdgLite },
  { url: (q) => `https://www.bing.com/search?q=${encodeURIComponent(q)}`, parse: parseBing }
];

async function search(query, limit) {
  let lastError = 'Search upstream unreachable.';
  for (const engine of ENGINES) {
    try {
      const res = await fetch(engine.url(query), { method: 'GET', headers: BROWSER_HEADERS });
      if (!res.ok) { lastError = `Search upstream returned ${res.status}`; continue; }
      const results = engine.parse(await res.text(), limit);
      if (results.length) return results;
      lastError = 'No results parsed from the search page.';
    } catch (err) {
      lastError = String(err?.message || err);
    }
  }
  throw new Error(lastError);
}

export default async function handler(request) {
  const url = new URL(request.url);
  let query = url.searchParams.get('q') || '';
  let limit = Number(url.searchParams.get('n')) || 8;
  if (request.method === 'POST') {
    try {
      const body = await request.json();
      query = body.q || query;
      if (body.n) limit = Number(body.n) || limit;
    } catch { /* keep query */ }
  }
  query = String(query).trim().slice(0, 400);
  limit = Math.min(Math.max(1, Math.round(limit)), 15);
  if (!query) return json({ error: 'Missing q.' }, 400);

  try {
    return json({ query, results: await search(query, limit) });
  } catch (err) {
    return json({ error: String(err?.message || err), results: [] }, 502);
  }
}
