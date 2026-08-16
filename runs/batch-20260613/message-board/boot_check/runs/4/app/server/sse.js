/**
 * Manages the pool of active Server-Sent Events (SSE) client connections
 * and provides a broadcast helper.
 */

/** @type {Set<import('express').Response>} */
const clients = new Set();

/**
 * Register an SSE response object so it receives future broadcasts.
 * @param {import('express').Response} res
 */
export function addClient(res) {
  clients.add(res);
  console.log(`[sse] client connected  – total: ${clients.size}`);
}

/**
 * Remove an SSE response object (called when the connection closes).
 * @param {import('express').Response} res
 */
export function removeClient(res) {
  clients.delete(res);
  console.log(`[sse] client disconnected – total: ${clients.size}`);
}

/**
 * Broadcast a named SSE event carrying a JSON payload to every connected client.
 * @param {string} event  – SSE event name
 * @param {unknown} data  – will be JSON-serialised as the event data
 */
export function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) {
    res.write(payload);
  }
}
