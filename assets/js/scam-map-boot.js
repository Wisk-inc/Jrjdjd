/* Scam Map: what this site changes about Scam Finder's viewer, without editing the viewer.
   It runs before scam-map.js and stands between the viewer and the network:
   - the viewer asks /api/scam-radar for the live map; here that is the map Scam Radar publishes
     on the scam-radar-data branch, so it works on any host;
   - the viewer asks /api/scam-finder to trace a link; here the request asks for the related
     sites too, and a host with no API gets a plain answer instead of a parse error;
   - the live map opens by itself when the page loads, unless a link was passed in. */
(() => {
  'use strict';
  const RADAR_MAP = 'https://raw.githubusercontent.com/Wisk-inc/Jrjdjd/scam-radar-data/radar-map.json';
  const realFetch = window.fetch.bind(window);
  const answer = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

  window.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    if (url.startsWith('/api/scam-radar')) {
      const stamp = Math.floor(Date.now() / 60000); // the published map changes about once a minute; the viewer asks every minute
      const response = await realFetch(`${RADAR_MAP}?t=${stamp}`, { cache: 'no-cache' }).catch(() => null);
      return response && response.ok ? response : answer({ error: 'the published map could not be reached. Try again in a minute' });
    }
    if (url.startsWith('/api/scam-finder?url=')) {
      const response = await realFetch(url.replace('?url=', '?depth=1&url='), init).catch(() => null);
      const type = (response && response.headers.get('content-type')) || '';
      if (!response || !type.includes('json')) {
        return answer({ error: 'tracing a link needs this site’s scan server, which is not running on this host. The live map still works' });
      }
      return response;
    }
    return realFetch(input, init);
  };

  document.addEventListener('DOMContentLoaded', () => {
    const params = new URLSearchParams(location.search);
    const radar = document.getElementById('lookup-radar');
    const go = document.getElementById('lookup-go');
    const input = document.getElementById('lookup-input');
    // Without the API there is nothing to trace a link with: say so on the form itself
    realFetch('/api/scam-finder?ping=1').then((r) => (r.ok ? r.json() : null)).catch(() => null).then((pong) => {
      if (pong && pong.ok === true && pong.tool === 'scam-finder') return;
      if (go) go.disabled = true;
      if (input) { input.disabled = true; input.placeholder = 'Tracing a link is not available on this host'; }
    });
    // The viewer wires its buttons in the same tick it loads, so by now a click reaches it
    if (radar && !params.get('url')) setTimeout(() => radar.click(), 0);
  });
})();
