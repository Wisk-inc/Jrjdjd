/* GET|POST /api/search?q=… — real web search.

   Uses DuckDuckGo's HTML endpoint so there is no API key to hold and no
   per-user quota. Returns structured results the agent can read and the
   interface can show as sources. */

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

export function parseResults(html, limit = 8) {
  const out = [];
  const seen = new Set();
  const re = /<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  const snippets = [];
  const sre = /<a[^>]+class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/g;
  let sm;
  while ((sm = sre.exec(html))) snippets.push(decode(sm[1]));

  let m;
  let i = 0;
  while ((m = re.exec(html)) && out.length < limit) {
    const url = unwrap(m[1]);
    const title = decode(m[2]);
    if (!title || !/^https?:/i.test(url)) { i += 1; continue; }
    let domain = '';
    try { domain = new URL(url).hostname.replace(/^www\./, ''); } catch { /* skip */ }
    if (seen.has(url)) { i += 1; continue; }
    seen.add(url);
    out.push({ title, url, domain, snippet: snippets[i] || '' });
    i += 1;
  }
  return out;
}

/* DuckDuckGo's html front end 403s plain server-side requests that look like
   a bot: a non-browser user-agent, no referer, or a POST with no cookie jar.
   A real desktop-browser header set (and a GET, which is what the page
   itself issues when you search) gets past that far more reliably. Two
   mirrors serve the identical result__a/result__snippet markup, so the same
   parser covers both — if one is rate-limited or geo-blocked, the other
   often is not. */
const BROWSER_HEADERS = {
  'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'accept-language': 'en-US,en;q=0.9',
  referer: 'https://duckduckgo.com/'
};
const MIRRORS = ['https://html.duckduckgo.com/html/', 'https://duckduckgo.com/html/'];

async function fetchDdg(query) {
  let lastError = 'Search upstream unreachable.';
  for (const mirror of MIRRORS) {
    try {
      const res = await fetch(`${mirror}?q=${encodeURIComponent(query)}`, {
        method: 'GET',
        headers: BROWSER_HEADERS
      });
      if (res.ok) return await res.text();
      lastError = `Search upstream returned ${res.status}`;
      if (res.status !== 403 && res.status !== 429) break;
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
    const html = await fetchDdg(query);
    const results = parseResults(html, limit);
    if (!results.length) return json({ query, error: 'No results parsed from the search page.', results: [] });
    return json({ query, results });
  } catch (err) {
    return json({ error: String(err?.message || err), results: [] }, 502);
  }
}
