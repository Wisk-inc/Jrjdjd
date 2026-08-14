/* POST /api/image — generate an image with the caller's own ChatGPT session.
   Returns a data URL the interface can render inline and offer as a download. */

import { openaiCredentials } from '@openai-oauth/web/server';
import { createOpenAIOAuthTransport } from '@openai-oauth/core';

export const config = { runtime: 'edge' };

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
  });

export default async function handler(request) {
  if (request.method !== 'POST') return json({ error: 'Use POST.' }, 405);

  let credentials;
  try {
    credentials = openaiCredentials(request);
  } catch {
    return json({ error: 'not_authenticated' }, 401);
  }

  let payload;
  try { payload = await request.json(); }
  catch { return json({ error: 'Body must be JSON.' }, 400); }

  const prompt = String(payload.prompt || '').trim();
  if (!prompt) return json({ error: 'Missing prompt.' }, 400);

  const transport = createOpenAIOAuthTransport({
    auth: () => credentials.getSession(),
    openAIBaseURL: credentials.openAIBaseURL
  });

  try {
    const res = await transport.request('/v1/images/generations', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        prompt,
        // The Codex catalog's image model. gpt-image-1 is not on this host.
        model: payload.model || 'gpt-image-2',
        size: payload.size || '1024x1024',
        n: 1
      })
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      return json(
        { error: 'upstream_error', status: res.status, message: detail.slice(0, 800) },
        res.status === 401 ? 401 : 502
      );
    }

    const body = await res.json();
    const first = body?.data?.[0] || {};
    const image = first.b64_json
      ? `data:image/png;base64,${first.b64_json}`
      : (first.url || '');
    if (!image) return json({ error: 'No image returned.' }, 502);
    return json({ image, revised_prompt: first.revised_prompt || '' });
  } catch (err) {
    return json({ error: String(err?.message || err) }, 502);
  }
}
