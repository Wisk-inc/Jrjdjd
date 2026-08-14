/* GET /api/models — the models the caller's own ChatGPT plan can reach.
   Populates the picker from the live list rather than a hardcoded one. */

import { openaiCredentials } from '@openai-oauth/web/server';
import { createOpenAIOAuthTransport } from '@openai-oauth/core';

export const config = { runtime: 'edge' };

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
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

  try {
    const res = await transport.request('/v1/models', { method: 'GET' });
    if (!res.ok) {
      return json({ error: 'upstream_error', status: res.status }, 502);
    }
    const body = await res.json();
    const models = (body && Array.isArray(body.data) ? body.data : [])
      .map((m) => (m && typeof m.id === 'string' ? m.id : null))
      .filter(Boolean);
    return json({ models });
  } catch (err) {
    return json(
      { error: 'upstream_unreachable', message: String(err && err.message ? err.message : err) },
      502
    );
  }
}
