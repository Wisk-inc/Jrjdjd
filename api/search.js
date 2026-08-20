/* GET|POST /api/search?q=… — real web search.

   No API key, no per-user quota: this scrapes public search result pages.
   That also means it is at the mercy of whichever engine's bot detection is
   in a mood that day, so it tries four in order — two DuckDuckGo mirrors,
   DuckDuckGo Lite, then Bing — and returns the first one that actually
   parses results, rather than giving up after a single 403. */

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
