/**
 * sseClients.js
 * Manages the in-memory set of active SSE response objects.
 * Provides helpers to register, remove, and broadcast to all clients.
 */

/** @type {Set<import('express').Response>} */
const clients = new Set();

/**
 * Register a new SSE client response object.
 * @param {import('express').Response} res
 */
export function addClient(res) {
  clients.add(res);
  console.log(`[sse] client connected  — total: ${clients.size}`);
}

/**
 * Remove an SSE client (called when the connection closes).
 * @param {import('express').Response} res
 */
export function removeClient(res) {
  clients.delete(res);
  console.log(`[sse] client disconnected — total: ${clients.size}`);
}

/**
 * Broadcast a named SSE event with a JSON payload to every connected client.
 * @param {string} event  - The SSE event name (e.g. "new-message")
 * @param {unknown} data  - Any JSON-serialisable value
 */
export function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) {
    res.write(payload);
  }
}
