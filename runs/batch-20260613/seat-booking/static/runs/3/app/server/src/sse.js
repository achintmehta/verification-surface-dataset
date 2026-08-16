/**
 * Server-Sent Events (SSE) broadcaster.
 *
 * Maintains a registry of active SSE response objects and provides a
 * `broadcast` function that pushes a named event + JSON payload to every
 * connected client.
 */

/** @type {Set<import('express').Response>} */
const clients = new Set();

/**
 * Register an SSE client response.  The caller is responsible for setting the
 * appropriate headers and keeping the connection open.
 *
 * @param {import('express').Response} res
 */
export function addClient(res) {
  clients.add(res);
}

/**
 * Remove an SSE client (called when the connection closes).
 *
 * @param {import('express').Response} res
 */
export function removeClient(res) {
  clients.delete(res);
}

/**
 * Broadcast a named SSE event to every connected client.
 *
 * @param {string} event  - SSE event name
 * @param {unknown} data  - Will be JSON-serialised as the `data` field
 */
export function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) {
    try {
      res.write(payload);
    } catch {
      // Client disconnected mid-write; remove it.
      clients.delete(res);
    }
  }
}

/**
 * Return the number of currently connected SSE clients (useful for health
 * checks / debugging).
 */
export function clientCount() {
  return clients.size;
}
