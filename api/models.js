/* GET /api/models — the models the caller's own ChatGPT plan can reach.

   The transport intercepts a plain GET /v1/models and answers it from the Codex
   catalog, but only after filtering to models marked `visibility: list` and
   `supported_in_api`. Passing client_version bypasses that interception and
   returns the raw catalog, which is a good deal longer — so this asks for the
   raw list, keeps everything usable, and marks the rest rather than hiding it.
*/

import { openaiCredentials } from '@openai-oauth/web/server';
import { createOpenAIOAuthTransport } from '@openai-oauth/core';

export const config = { runtime: 'edge' };

/* Only used when the catalog cannot be reached at all, so the picker is never
   empty. Anything here still has to be allowed by the caller's own plan. */
const FALLBACK = [
  'gpt-5.2', 'gpt-5.2-codex', 'gpt-5.1', 'gpt-5.1-codex', 'gpt-5.1-codex-mini',
  'gpt-5', 'gpt-5-codex'
];

const CODEX_CLIENT_VERSION = '0.144.1';

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
  });

/* Newest first, codex variants next to their base model, mini last. */
const rank = (id) => {
  const version = Number((id.match(/gpt-(\d+(?:\.\d+)?)/) || [])[1] || 0);
  return [-version, /codex/.test(id) ? 1 : 0, /mini/.test(id) ? 1 : 0, id];
};
const sortModels = (ids) => ids.sort((a, b) => {
  const ra = rank(a), rb = rank(b);
  for (let i = 0; i < ra.length; i += 1) {
    if (ra[i] < rb[i]) return -1;
    if (ra[i] > rb[i]) return 1;
  }
  return 0;
});

export default async function handler(request) {
  let credentials;
  try {
    credentials = openaiCredentials(request);
  } catch {
    return json({
      error: 'missing_credentials',
      sawAuthorization: Boolean(request.headers.get('authorization')),
      sawAccountId: Boolean(request.headers.get('chatgpt-account-id'))
    }, 401);
  }

  const transport = createOpenAIOAuthTransport({
    auth: () => credentials.getSession(),
    openAIBaseURL: credentials.openAIBaseURL
  });

  // 1. The raw catalog — the longest honest list.
  try {
    const res = await transport.request(`/models?client_version=${CODEX_CLIENT_VERSION}`);
    if (res.ok) {
      const body = await res.json();
      const entries = Array.isArray(body?.models) ? body.models : [];
      const catalog = entries
        .filter((m) => m && typeof m.slug === 'string' && m.supported_in_api !== false)
        .map((m) => ({
          id: m.slug,
          listed: m.visibility === undefined || m.visibility === 'list',
          reasoning: typeof m.default_reasoning_level === 'string' ? m.default_reasoning_level : '',
          plans: Array.isArray(m.available_in_plans) ? m.available_in_plans : []
        }));
      if (catalog.length) {
        const ids = sortModels(catalog.map((m) => m.id));
        return json({ models: ids, catalog, source: 'catalog' });
      }
    }
  } catch { /* fall through to the filtered list */ }

  // 2. The transport's own filtered view.
  try {
    const res = await transport.request('/v1/models', { method: 'GET' });
    if (res.ok) {
      const body = await res.json();
      const ids = (Array.isArray(body?.data) ? body.data : [])
        .map((m) => (m && typeof m.id === 'string' ? m.id : null))
        .filter(Boolean);
      if (ids.length) return json({ models: sortModels(ids), source: 'filtered' });
    }
  } catch { /* fall through to the fallback */ }

  // 3. Never hand back an empty picker.
  return json({ models: FALLBACK, source: 'fallback' });
}
