/**
 * api.js
 * Thin wrapper around the backend HTTP API.
 * All paths are relative so they work both through the Vite dev-server proxy
 * and when the frontend is served directly from the Express server in
 * production.
 */

const BASE = '/api';

/**
 * Fetches the full message history from the server.
 *
 * @returns {Promise<Array<{id: number, text: string, created_at: string}>>}
 */
export async function fetchMessages() {
  const res = await fetch(`${BASE}/messages`);
  if (!res.ok) {
    throw new Error(`Failed to fetch messages: ${res.status} ${res.statusText}`);
  }
  return res.json();
}

/**
 * Posts a new message to the server.
 *
 * @param {string} text - The message text to send.
 * @returns {Promise<{id: number, text: string, created_at: string}>}
 */
export async function postMessage(text) {
  const res = await fetch(`${BASE}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `Server error: ${res.status}`);
  }
  return res.json();
}

/**
 * Opens an EventSource connection to the SSE stream endpoint.
 *
 * @returns {EventSource}
 */
export function openStream() {
  return new EventSource(`${BASE}/stream`);
}
