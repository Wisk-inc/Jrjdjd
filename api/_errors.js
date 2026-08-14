/* Classifying an upstream failure.

   A refusal from the API and a refusal from the network edge look nothing alike
   and mean opposite things — one is about your plan, the other is about where
   the request came from — so they must not be reported with the same sentence.

   No dependencies here on purpose, so it can be exercised directly. */

/* Cloudflare's block page, which is what comes back when the edge refuses the
   request rather than the API refusing the account. It is always HTML and it
   always carries a Ray ID. */
const RAY = /Ray ID:\s*([0-9a-f]+)/i;
const CLIENT_IP = /IP:\s*([0-9a-f.:]+)/i;

export const looksBlocked = (detail) =>
  /^\s*</.test(String(detail || '')) &&
  (RAY.test(detail) || /Unable to load site|attention required|cloudflare/i.test(detail));

/* Upstream failures often come back as a full HTML error page. Pulling the
   readable part out beats pasting a stylesheet into the chat. */
export function summarise(detail) {
  const text = String(detail || '');
  if (!text) return '';
  if (/^\s*</.test(text)) {
    const stripped = text
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]*>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    return stripped.slice(0, 300) || 'The upstream returned an HTML error page.';
  }
  try {
    const parsed = JSON.parse(text);
    const message = parsed?.error?.message || parsed?.detail || parsed?.message;
    if (typeof message === 'string' && message) return message.slice(0, 500);
  } catch { /* not JSON */ }
  return text.slice(0, 500);
}

/* Turns an upstream failure into the payload the client renders. */
export function classify(status, detail, extra = {}) {
  if (looksBlocked(detail)) {
    return {
      body: {
        error: 'upstream_blocked',
        status,
        ray: (detail.match(RAY) || [])[1] || '',
        blockedIp: (detail.match(CLIENT_IP) || [])[1] || '',
        message:
          'ChatGPT’s network edge refused the request before it reached the API. ' +
          'This is not about your plan or your account — it is about the address the ' +
          'request came from, which is this website’s server, not your computer.',
        ...extra
      },
      status: 502
    };
  }

  const rejected = status === 401 || status === 403;
  return {
    body: {
      error: rejected ? 'upstream_rejected' : 'upstream_error',
      status,
      message: summarise(detail),
      ...extra
    },
    status: rejected ? 403 : 502
  };
}
