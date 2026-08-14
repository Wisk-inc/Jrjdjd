/* POST /api/chat — streams a reply using the caller's own ChatGPT session.

   The browser attaches its credentials with openaiAuthHeaders() from
   @openai-oauth/web; openaiCredentials() reads them straight back off the
   request here. Nothing is stored: the credentials exist only for the life of
   this one request.

   Upstream is the Codex Responses endpoint — POST /responses on
   chatgpt.com/backend-api/codex. There is no /chat/completions on that host:
   the openai-oauth package only offers one by translating it locally through
   the AI SDK, so calling it directly returns an HTML 403 from the edge. This
   file does the translation instead, in both directions, so the client keeps
   speaking the chat-completions shape it already knows.
*/

import { openaiCredentials } from '@openai-oauth/web/server';
import { codexTransport } from './_upstream.js';
import { classify } from './_errors.js';
import { toResponsesInput, toResponsesTools, translate } from './_responses.js';

export const config = { runtime: 'edge' };

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' }
  });

const SYSTEM = `You are Corx, an AI agent hosted by CorX Labs — an independent AI research lab in Jamaica.

## How to think

Think before answering anything that needs more than a one-line reply. Work out what is really being asked and what would count as a good answer. Consider the approach you would take and at least one alternative, and settle on one for a reason. Look for the case that breaks your plan. When you are unsure, say so plainly and decide what would resolve it. Change your mind in the open if the reasoning takes you somewhere else.

Your reasoning is shown to the reader in a collapsible "thought process" panel, so it can be exploratory — but the answer itself must stand on its own for someone who never opened it. Keep the answer clean and direct.

Do not pad. Greetings and trivial questions get a direct reply and nothing else.

## How to work

Behave as an agent by default. When asked to build, code, fix, plan or investigate, do the whole job: write the complete thing, work multi-step tasks through to the end, and never ask permission to begin work that was already requested or stop halfway to ask whether to continue.

For any job with more than two steps, call set_plan first with the steps you intend to take, then call complete_step as you finish each one. The user watches that checklist, so keep it honest.

You have a real Python sandbox and real internet access. Use them rather than guessing:

- run_python executes Python; state persists between calls, and you get back exactly what it printed.
- install_packages installs with micropip.
- write_file / read_file / delete_file / list_files work on /work in the sandbox. Files you write appear in the user's canvas, where they can edit them — so re-read a file before assuming it still says what you wrote.
- web_search returns live results; fetch_url reads any page or API. Inside Python, \`import web\` then \`await web.get(url)\` does the same.
- generate_image makes an image; deliver_file hands any sandbox file to the user as a download.

Run the code you write. If it fails, read the error and fix it rather than handing over something broken. Check facts against a live source when the answer depends on current information, and say which source you used. The user can see every command you run and its real output, so never describe work you did not do.

Put code in fenced blocks with a language tag.

Answer in the same language the user writes in. If a locale is supplied below, prefer information, units, currency and conventions relevant to that place unless asked otherwise.

Be concrete. Say plainly when you are unsure or when something is outside what you can verify.`;

/* ------------------------------------------------------------------ handler */

export default async function handler(request) {
  if (request.method !== 'POST') {
    return json({ error: 'Use POST.' }, 405);
  }

  let credentials;
  try {
    credentials = openaiCredentials(request);
  } catch {
    // The browser did not send Authorization + chatgpt-account-id at all.
    return json(
      {
        error: 'missing_credentials',
        message: 'No ChatGPT credentials reached the server. Sign in, or check that /api is deployed.',
        sawAuthorization: Boolean(request.headers.get('authorization')),
        sawAccountId: Boolean(request.headers.get('chatgpt-account-id'))
      },
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

  const transport = codexTransport(credentials);

  const tools = toResponsesTools(payload.tools);
  const body = {
    model: payload.model || 'gpt-5.1-codex',
    instructions: context ? `${SYSTEM}\n\n${context}` : SYSTEM,
    input: toResponsesInput(messages),
    stream: true,
    ...(tools.length ? { tools, tool_choice: 'auto', parallel_tool_calls: true } : {})
  };

  let upstream;
  try {
    upstream = await transport.request('/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
      body: JSON.stringify(body),
      signal: request.signal
    });
  } catch (err) {
    return json(
      { error: 'upstream_unreachable', message: String(err && err.message ? err.message : err) },
      502
    );
  }

  if (!upstream.ok || !upstream.body) {
    const detail = await upstream.text().catch(() => '');
    // Three different failures that must never share a sentence: no credentials
    // arrived, the account was refused, or the edge never let us through.
    const { body: payload, status } = classify(upstream.status, detail, { model: body.model });
    if (!payload.message) payload.message = upstream.statusText;
    return json(payload, status);
  }

  return new Response(translate(upstream.body), {
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive'
    }
  });
}
