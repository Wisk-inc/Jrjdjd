/* GET|POST /api/images?q=… — real image search.

   Backed by Wikimedia Commons' public API: no key, no quota, and everything
   it returns is freely licensed with a named author, which is what you want
   if the picture is going to be shown to someone. Runs server-side (like
   /api/search) so the browser never has to care about CORS. */

export const config = { runtime: 'edge' };

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
  });

const strip = (s) =>
  String(s || '').replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').replace(/&quot;/g, '"')
    .replace(/&#0?39;|&#x27;/g, "'").replace(/\s+/g, ' ').trim();

export function parseCommons(data, limit) {
  const pages = Object.values(data?.query?.pages || {});
  // The API returns pages keyed arbitrarily; `index` preserves search rank.
  pages.sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
  const out = [];
  for (const p of pages) {
    const info = p.imageinfo?.[0];
    if (!info) continue;
    const url = info.thumburl || info.url;
    if (!url || !/^https:\/\//i.test(url)) continue;
    // Skip formats a browser won't render inline.
    if (/\.(tif|tiff|svg|xcf|djvu|pdf|webm|ogv)$/i.test(info.url || '')) continue;
    const meta = info.extmetadata || {};
    out.push({
      url,
      full: info.descriptionurl || info.url,
      title: strip(p.title).replace(/^File:/, '').replace(/\.[a-z0-9]+$/i, ''),
      width: info.thumbwidth || info.width || null,
      height: info.thumbheight || info.height || null,
      credit: strip(meta.Artist?.value) || 'Wikimedia Commons',
      licence: strip(meta.LicenseShortName?.value) || ''
    });
    if (out.length >= limit) break;
  }
  return out;
}

export default async function handler(request) {
  const url = new URL(request.url);
  let query = url.searchParams.get('q') || '';
  let limit = Number(url.searchParams.get('n')) || 4;
  if (request.method === 'POST') {
    try {
      const body = await request.json();
      query = body.q || query;
      if (body.n) limit = Number(body.n) || limit;
    } catch { /* keep the query string values */ }
  }
  query = String(query).trim().slice(0, 300);
  limit = Math.min(Math.max(1, Math.round(limit)), 8);
  if (!query) return json({ error: 'Missing q.' }, 400);

  const api = 'https://commons.wikimedia.org/w/api.php?' + new URLSearchParams({
    action: 'query',
    generator: 'search',
    gsrsearch: query,
    gsrnamespace: '6',              // File: namespace only
    gsrlimit: String(limit * 3),    // over-fetch, we filter unrenderable types
    prop: 'imageinfo',
    iiprop: 'url|extmetadata',
    iiurlwidth: '640',              // ask for a sane thumbnail, not the original
    format: 'json',
    origin: '*'
  }).toString();

  try {
    const res = await fetch(api, {
      headers: {
        accept: 'application/json',
        'user-agent': 'CorX-Chat/1.0 (https://corx-labs.com/chat/)'
      }
    });
    if (!res.ok) return json({ error: `Image search returned ${res.status}`, results: [] }, 502);
    const data = await res.json();
    const results = parseCommons(data, limit);
    if (!results.length) return json({ query, error: 'No usable images found.', results: [] });
    return json({ query, results });
  } catch (err) {
    return json({ error: String(err?.message || err), results: [] }, 502);
  }
}
