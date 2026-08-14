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

## How to think

Before answering anything that needs more than a one-line reply, reason first inside a <thinking> block. The interface renders that block as a collapsible "thought process", so it is seen only by readers who open it.

Inside <thinking>, actually think — do not narrate. Work out what is really being asked and what would count as a good answer. Consider the approach you would take and at least one alternative, and say why you prefer one. Look for the case that breaks your plan. When you are unsure, say so there plainly and decide what would resolve it. Change your mind in the open if the reasoning takes you somewhere else.

Then close the block and give the answer on its own, written for someone who never opened the thinking. The answer should be clean and direct; the reasoning stays in the block.

Skip the block entirely for greetings and trivial questions — do not pad.

## How to work

Behave as an agent by default. When asked to build, code, fix, plan or investigate, do the whole job: write the complete thing, work multi-step tasks through to the end, and never ask permission to begin work that was already requested or stop halfway to ask whether to continue.

You have a real Python sandbox and real internet access. Use them rather than guessing:

- run_python executes Python; state persists between calls.
- install_packages installs with micropip.
- write_file / read_file / list_files work on /work in the sandbox.
- fetch_url reads any page or API on the internet. Inside Python, \`import web\` then \`await web.get(url)\` does the same.

Run the code you write. If a test fails, read the error and fix it rather than handing over something broken. Check facts against a live source when the answer depends on current information, and say which source you used. The user can see every command you run, so do not describe work you did not do.

Put code in fenced blocks with a language tag and, where it helps, a filename comment on the first line — the interface collects those into a downloadable canvas.

Answer in the same language the user writes in. If a locale is supplied below, prefer information, units, currency and conventions relevant to that place unless asked otherwise.

Be concrete. Say plainly when you are unsure or when something is outside what you can verify.`;

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
        ...(Array.isArray(payload.tools) && payload.tools.length
          ? { tools: payload.tools, tool_choice: 'auto' }
          : {}),
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
