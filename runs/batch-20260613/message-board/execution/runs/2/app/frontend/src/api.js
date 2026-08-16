/**
 * Thin API client for the message-board backend.
 *
 * The base URL is resolved from the Vite env variable VITE_API_URL so that
 * the same build can target different environments. During development the
 * Vite dev server proxies /api to the Express backend, so the default empty
 * string works out of the box.
 */

const BASE_URL = (import.meta.env.VITE_API_URL ?? '').replace(/\/$/, '');

/**
 * Fetch all historical messages from the server.
 * @returns {Promise<Array<{id: number, text: string, created_at: string}>>}
 */
export async function fetchMessages() {
  const res = await fetch(`${BASE_URL}/api/messages`);
  if (!res.ok) throw new Error(`GET /api/messages failed: ${res.status}`);
  return res.json();
}

/**
 * Post a new message to the server.
 * @param {string} text
 * @returns {Promise<{id: number, text: string, created_at: string}>}
 */
export async function postMessage(text) {
  const res = await fetch(`${BASE_URL}/api/messages`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ text }),
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `POST /api/messages failed: ${res.status}`);
  }

  return res.json();
}

/**
 * Open an SSE connection to the server's stream endpoint.
 *
 * @param {object} handlers
 * @param {(msg: {id: number, text: string, created_at: string}) => void} handlers.onMessage
 * @param {() => void} handlers.onOpen
 * @param {(err: Event) => void} handlers.onError
 * @returns {EventSource}  – call .close() to disconnect
 */
export function openStream({ onMessage, onOpen, onError }) {
  const es = new EventSource(`${BASE_URL}/api/stream`);

  es.addEventListener('new-message', (e) => {
    try {
      const message = JSON.parse(e.data);
      onMessage(message);
    } catch (err) {
      console.error('[sse] failed to parse message payload:', err);
    }
  });

  es.addEventListener('open', () => {
    onOpen?.();
  });

  es.addEventListener('error', (err) => {
    onError?.(err);
  });

  return es;
}
