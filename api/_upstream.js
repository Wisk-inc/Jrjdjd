/* Shared setup for every call to the Codex backend.

   The transport is built with a real header set. The library adds only
   Authorization and chatgpt-account-id; the AI SDK path it documents also
   contributes a User-Agent and an Accept, and a request arriving at chatgpt.com
   with neither is liable to be turned away at the edge before it ever reaches
   the API.

   Failure classification lives next door in _errors.js, which has no
   dependencies so it can be tested directly.
*/

import { createOpenAIOAuthTransport } from '@openai-oauth/core';

/* The Codex client version the catalog is asked for. Kept in one place so the
   models route and the User-Agent cannot drift apart. */
export const CODEX_CLIENT_VERSION = '0.144.1';

const UA = `corx-labs-chat/1.0 (+https://corx-labs.com/chat/) openai-oauth/2.0.0 codex/${CODEX_CLIENT_VERSION}`;

export function codexTransport(credentials) {
  return createOpenAIOAuthTransport({
    auth: () => credentials.getSession(),
    openAIBaseURL: credentials.openAIBaseURL,
    headers: {
      // Matched to the configuration the library's own hosted demo uses: an
      // identifying User-Agent and an Accept, and nothing else. Codex CLI
      // protocol headers (originator, version) are deliberately NOT sent —
      // the library never sends them either, and claiming to be the CLI while
      // plainly not being it is as likely to trip a rule as satisfy one.
      'user-agent': UA,
      accept: 'application/json',
      'accept-language': 'en-US,en;q=0.9'
    }
  });
}
