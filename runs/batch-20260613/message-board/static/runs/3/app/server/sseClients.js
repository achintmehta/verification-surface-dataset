/**
 * sseClients.js
 * Manages the in-memory set of active SSE response objects.
 * Any module can import { addClient, removeClient, broadcast } to interact
 * with the live connection pool.
 */

/** @type {Set<import('express').Response>} */
const clients = new Set();

/**
 * Register a new SSE client response object.
 * @param {import('express').Response} res
 */
export function addClient(res) {
  clients.add(res);
  console.log(`[sse] client connected  – total: ${clients.size}`);
}

/**
 * Remove a disconnected SSE client response object.
 * @param {import('express').Response} res
 */
export function removeClient(res) {
  clients.delete(res);
  console.log(`[sse] client disconnected – total: ${clients.size}`);
}

/**
 * Broadcast a JSON-serialisable payload to every connected SSE client.
 * Uses the standard SSE `data:` field format followed by two newlines.
 *
 * @param {string} event  - The SSE event name (e.g. "message")
 * @param {unknown} data  - The payload; will be JSON-stringified
 */
export function broadcast(event, data) {
  const chunk = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) {
    res.write(chunk);
  }
  console.log(`[sse] broadcast "${event}" to ${clients.size} client(s)`);
}
