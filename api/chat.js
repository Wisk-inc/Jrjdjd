/* POST /api/chat — streams a chat completion using the caller's own ChatGPT
   session.

   The browser attaches its credentials with openaiAuthHeaders() from
   @openai-oauth/web; openaiCredentials() reads them straight back off the
   request here. Nothing is stored: the credentials exist only for the life of
   this one request. */

import { openaiCredentials } from '@openai-oauth/web/server';
import { createOpenAIOAuthTransport } from '@openai-oauth/core';

export const config = { runtime: 'edge' };

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' }
  });

const SYSTEM = `You are CorX Chat, an AI assistant hosted by CorX Labs — an independent AI research lab in Jamaica.

Behave as a capable agent by default. When the user asks you to build, code, fix, plan or research something, just do it: write the complete code, work through multi-step jobs to the end, and produce finished output. Never ask the user to switch to an "agent mode" and never ask permission to begin work that was already requested.

When you write code, always put it in a fenced markdown block with the language tag and, where it helps, a filename comment on the first line — the interface collects those blocks into a downloadable canvas.

Answer in the same language the user writes in. If the user's locale is supplied below, prefer information, units, currency and conventions relevant to that place, unless they ask otherwise.

Be direct and concrete. Say plainly when you are unsure or when something is outside what you can verify.`;

export default async function handler(request) {
  if (request.method !== 'POST') {
    return json({ error: 'Use POST.' }, 405);
  }

  let credentials;
  try {
    credentials = openaiCredentials(request);
  } catch (err) {
    return json(
      { error: 'not_authenticated', message: 'Sign in with ChatGPT first.' },
      401
    );
  }

  let payload;
  try {
    payload = await request.json();
  } catch {
    return json({ error: 'bad_request', message: 'Body must be JSON.' }, 400);
  }

  const messages = Array.isArray(payload.messages) ? payload.messages : [];
  if (!messages.length) {
    return json({ error: 'bad_request', message: 'No messages supplied.' }, 400);
  }

  const locale = typeof payload.locale === 'string' ? payload.locale.slice(0, 80) : '';
  const region = typeof payload.region === 'string' ? payload.region.slice(0, 80) : '';
  const context = [locale && `User locale: ${locale}`, region && `User region: ${region}`]
    .filter(Boolean)
    .join('\n');

  const transport = createOpenAIOAuthTransport({
    auth: () => credentials.getSession(),
    openAIBaseURL: credentials.openAIBaseURL
  });

  let upstream;
  try {
    upstream = await transport.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: payload.model || 'gpt-5.1-codex',
        stream: true,
        messages: [
          { role: 'system', content: context ? `${SYSTEM}\n\n${context}` : SYSTEM },
          ...messages
        ]
      })
    });
  } catch (err) {
    return json(
      { error: 'upstream_unreachable', message: String(err && err.message ? err.message : err) },
      502
    );
  }

  if (!upstream.ok || !upstream.body) {
    const detail = await upstream.text().catch(() => '');
    return json(
      {
        error: 'upstream_error',
        status: upstream.status,
        message: detail.slice(0, 1200) || upstream.statusText
      },
      upstream.status === 401 || upstream.status === 403 ? 401 : 502
    );
  }

  // Pass the SSE stream straight through — the client parses the deltas.
  return new Response(upstream.body, {
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive'
    }
  });
}
