// Vercel wrapper for api-core.mjs. build-bundles.mjs turns this into /api/scam-finder.js.
// Loaded on the first request, so a failure to start comes back as JSON that says why, not as a
// bare 500 from the platform
let core = null;

module.exports = async (req, res) => {
  let handle;
  try {
    core ||= require('./api-core.mjs');
    ({ handle } = core);
  } catch (error) {
    res.statusCode = 500;
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.setHeader('cache-control', 'no-store');
    res.end(JSON.stringify({ error: `The scan API could not start: ${String(error && error.message).slice(0, 200)}` }));
    return;
  }
  const url = new URL(req.url || '/', 'https://corx-labs.com');
  // Vercel sets x-real-ip itself; x-forwarded-for is the fallback on other hosts
  const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  const out = await handle({
    method: req.method,
    query: Object.fromEntries(url.searchParams),
    address: String(req.headers['x-real-ip'] || '').trim() || forwarded || req.socket?.remoteAddress || 'unknown',
  });
  res.statusCode = out.status;
  for (const [name, value] of Object.entries(out.headers)) res.setHeader(name, value);
  res.end(req.method === 'HEAD' ? '' : JSON.stringify(out.body));
};
