/**
 * sse.js – Server-Sent Events broadcast hub.
 *
 * Any module can call `broadcast(event, data)` to push a JSON message to every
 * currently connected SSE client.  The Express route handler for GET /api/stream
 * registers / deregisters clients here.
 */

/** @type {Set<import('express').Response>} */
const clients = new Set();

/**
 * Register an SSE response object.
 * @param {import('express').Response} res
 */
export function addClient(res) {
  clients.add(res);
}

/**
 * Deregister an SSE response object (called when the connection closes).
 * @param {import('express').Response} res
 */
export function removeClient(res) {
  clients.delete(res);
}

/**
 * Broadcast a named SSE event to all connected clients.
 *
 * @param {string} event  – SSE event name (e.g. "seat-update")
 * @param {unknown} data  – JSON-serialisable payload
 */
export function broadcast(event, data) {
  if (clients.size === 0) return;
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) {
    try {
      res.write(payload);
    } catch {
      // Client disconnected mid-write; clean up.
      clients.delete(res);
    }
  }
}

/** Returns the number of currently connected SSE clients (useful for logging). */
export function clientCount() {
  return clients.size;
}
