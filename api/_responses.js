/* Translation between the chat-completions shape the client speaks and the
   Codex Responses endpoint that actually exists upstream.

   Kept apart from api/chat.js so it can be exercised directly, without the
   auth packages that only resolve once the host installs dependencies. */

/* ------------------------------------------------- chat shape → responses */

const textOf = (content) => {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter((c) => c && c.type === 'text').map((c) => c.text || '').join('\n');
};

/* Chat messages carry tool calls on the assistant turn and results in their own
   `tool` turns. Responses wants both as top-level items. */
export function toResponsesInput(messages) {
  const input = [];

  for (const m of messages) {
    if (!m || typeof m !== 'object') continue;

    if (m.role === 'tool') {
      input.push({
        type: 'function_call_output',
        call_id: String(m.tool_call_id || ''),
        output: String(m.content ?? '')
      });
      continue;
    }

    if (m.role === 'assistant') {
      const text = textOf(m.content);
      if (text) {
        input.push({ role: 'assistant', content: [{ type: 'output_text', text }] });
      }
      for (const call of m.tool_calls || []) {
        input.push({
          type: 'function_call',
          call_id: String(call.id || ''),
          name: String(call.function?.name || ''),
          arguments: String(call.function?.arguments || '{}')
        });
      }
      continue;
    }

    // user / system / developer
    const role = m.role === 'system' ? 'developer' : 'user';
    if (Array.isArray(m.content)) {
      const parts = [];
      for (const part of m.content) {
        if (!part) continue;
        if (part.type === 'text') parts.push({ type: 'input_text', text: String(part.text || '') });
        else if (part.type === 'image_url') {
          const url = typeof part.image_url === 'string' ? part.image_url : part.image_url?.url;
          if (url) parts.push({ type: 'input_image', image_url: String(url) });
        }
      }
      if (parts.length) input.push({ role, content: parts });
    } else {
      const text = String(m.content ?? '');
      if (text) input.push({ role, content: [{ type: 'input_text', text }] });
    }
  }

  return input;
}

export const toResponsesTools = (tools) =>
  (Array.isArray(tools) ? tools : [])
    .map((t) => t?.function)
    .filter(Boolean)
    .map((f) => ({
      type: 'function',
      name: f.name,
      description: f.description || '',
      parameters: f.parameters || { type: 'object', properties: {} },
      strict: false
    }));

/* ------------------------------------------------- responses SSE → chat SSE */

const frame = (delta) =>
  `data: ${JSON.stringify({ object: 'chat.completion.chunk', choices: [{ index: 0, delta }] })}\n\n`;

/* Reasoning arrives as its own event stream. The client renders a <thinking>
   block as the collapsible panel, so the summary is wrapped in one — opened on
   the first reasoning delta and closed the moment real output starts. */
export function translate(upstreamBody) {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = '';
  let thinkOpen = false;
  let thinkClosed = false;
  const toolIndex = new Map();   // response item id -> tool_calls index
  let nextIndex = 0;

  const closeThinking = (out) => {
    if (thinkOpen && !thinkClosed) {
      thinkClosed = true;
      out.push(frame({ content: '</thinking>\n\n' }));
    }
  };

  const handle = (evt, out) => {
    const type = evt?.type;
    if (!type) return;

    if (type === 'response.reasoning_summary_text.delta' || type === 'response.reasoning_text.delta') {
      if (thinkClosed) return;
      if (!thinkOpen) { thinkOpen = true; out.push(frame({ content: '<thinking>\n' })); }
      if (evt.delta) out.push(frame({ content: String(evt.delta) }));
      return;
    }

    if (type === 'response.reasoning_summary_part.added' && thinkOpen && !thinkClosed) {
      out.push(frame({ content: '\n\n' }));
      return;
    }

    if (type === 'response.output_text.delta') {
      closeThinking(out);
      if (evt.delta) out.push(frame({ content: String(evt.delta) }));
      return;
    }

    if (type === 'response.output_item.added' && evt.item?.type === 'function_call') {
      closeThinking(out);
      const id = evt.item.id || evt.item.call_id;
      if (id != null && !toolIndex.has(id)) toolIndex.set(id, nextIndex++);
      return;
    }

    /* Arguments are emitted whole, on completion. Streaming them token by token
       would risk double-counting against the deltas the client concatenates,
       and a half-parsed argument is no use to anyone. */
    if (type === 'response.output_item.done' && evt.item?.type === 'function_call') {
      closeThinking(out);
      const item = evt.item;
      const id = item.id || item.call_id;
      if (!toolIndex.has(id)) toolIndex.set(id, nextIndex++);
      out.push(frame({
        tool_calls: [{
          index: toolIndex.get(id),
          id: String(item.call_id || item.id || ''),
          type: 'function',
          function: { name: String(item.name || ''), arguments: String(item.arguments || '{}') }
        }]
      }));
      return;
    }

    if (type === 'response.failed' || type === 'error') {
      closeThinking(out);
      const message = evt.response?.error?.message || evt.message || 'The model run failed.';
      out.push(frame({ content: `\n\n**Upstream error:** ${message}` }));
    }
  };

  return new ReadableStream({
    async start(controller) {
      const reader = upstreamBody.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const blocks = buffer.split(/\r?\n\r?\n/);
          buffer = blocks.pop() || '';
          for (const block of blocks) {
            const data = block.split(/\r?\n/)
              .filter((l) => l.startsWith('data:'))
              .map((l) => l.slice(5).trim())
              .join('\n');
            if (!data || data === '[DONE]') continue;
            let evt;
            try { evt = JSON.parse(data); } catch { continue; }
            const out = [];
            handle(evt, out);
            for (const chunk of out) controller.enqueue(encoder.encode(chunk));
          }
        }
        const tail = [];
        closeThinking(tail);
        for (const chunk of tail) controller.enqueue(encoder.encode(chunk));
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
      } catch (err) {
        controller.enqueue(encoder.encode(frame({ content: `\n\n**Stream error:** ${err?.message || err}` })));
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
      } finally {
        controller.close();
        reader.releaseLock?.();
      }
    }
  });
}

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
