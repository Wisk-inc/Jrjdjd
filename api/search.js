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
    const res = await fetch('https://html.duckduckgo.com/html/', {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'user-agent': 'Mozilla/5.0 (compatible; CorX-Chat/1.0; +https://corx-labs.com/chat/)',
        accept: 'text/html'
      },
      body: new URLSearchParams({ q: query }).toString()
    });
    if (!res.ok) return json({ error: `Search upstream returned ${res.status}`, results: [] }, 502);
    const html = await res.text();
    return json({ query, results: parseResults(html, limit) });
  } catch (err) {
    return json({ error: String(err?.message || err), results: [] }, 502);
  }
}
