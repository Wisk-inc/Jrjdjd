// Netlify wrapper for api-core.mjs. build-bundles.mjs turns this into /netlify/functions/scam-finder.js.
const { handle, installNetworkGuard } = require('./api-core.mjs');

// Every request this function makes is checked before it connects (see api-core.mjs)
installNetworkGuard();

exports.handler = async (event) => {
  const headers = event.headers || {};
  const out = await handle({
    method: event.httpMethod,
    query: event.queryStringParameters || {},
    address: headers['x-nf-client-connection-ip'] || String(headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown',
  });
  return { statusCode: out.status, headers: out.headers, body: event.httpMethod === 'HEAD' ? '' : JSON.stringify(out.body) };
};
