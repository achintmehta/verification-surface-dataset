/**
 * Thin client for the message board API. All requests are same-origin: in
 * development Vite proxies `/api/*` to the Express backend, and in production
 * the built assets are served alongside the API.
 */

/**
 * @typedef {Object} Message
 * @property {number} id
 * @property {string} text
 * @property {string} created_at
 */

/**
 * Fetch the full message history.
 * @returns {Promise<Message[]>}
 */
export async function fetchMessages() {
  const res = await fetch('/api/messages');
  if (!res.ok) {
    throw new Error(`Failed to load messages (${res.status})`);
  }
  return res.json();
}

/**
 * Post a new message to the board.
 * @param {string} text
 * @returns {Promise<Message>}
 */
export async function postMessage(text) {
  const res = await fetch('/api/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  });
  if (!res.ok) {
    let detail = '';
    try {
      const body = await res.json();
      detail = body?.error ? `: ${body.error}` : '';
    } catch {
      // ignore JSON parse errors
    }
    throw new Error(`Failed to post message (${res.status})${detail}`);
  }
  return res.json();
}

/**
 * Open a Server-Sent Events stream and invoke the provided callbacks.
 *
 * @param {Object} handlers
 * @param {(message: Message) => void} handlers.onMessage - new message arrived
 * @param {() => void} [handlers.onOpen]  - stream connected
 * @param {() => void} [handlers.onError] - stream errored / disconnected
 * @returns {EventSource}
 */
export function connectStream({ onMessage, onOpen, onError }) {
  const source = new EventSource('/api/stream');

  source.addEventListener('open', () => onOpen?.());

  source.addEventListener('message', (event) => {
    try {
      const message = JSON.parse(event.data);
      onMessage(message);
    } catch (err) {
      console.error('Failed to parse SSE message:', err);
    }
  });

  source.addEventListener('error', () => onError?.());

  return source;
}
