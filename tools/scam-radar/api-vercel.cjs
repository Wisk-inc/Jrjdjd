// Vercel wrapper for api-core.mjs. build-bundles.mjs turns this into /api/scam-finder.js.
const { handle } = require('./api-core.mjs');

module.exports = async (req, res) => {
  const url = new URL(req.url || '/', 'https://corx-labs.com');
  const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  const out = await handle({
    method: req.method,
    query: Object.fromEntries(url.searchParams),
    address: forwarded || req.socket?.remoteAddress || 'unknown',
  });
  res.statusCode = out.status;
  for (const [name, value] of Object.entries(out.headers)) res.setHeader(name, value);
  res.end(req.method === 'HEAD' ? '' : JSON.stringify(out.body));
};
