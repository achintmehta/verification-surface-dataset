/**
 * Server-Sent Events broadcast hub.
 *
 * Any module can call `broadcast(event, data)` and every connected client
 * will receive the message.  The SSE endpoint itself is mounted in routes.js.
 */

/** @type {Set<import('express').Response>} */
const clients = new Set();

/**
 * Register a new SSE response object.
 * The caller is responsible for writing the initial headers before calling
 * this function.
 * @param {import('express').Response} res
 */
export function addClient(res) {
  clients.add(res);
}

/**
 * Remove a client (called when the connection closes).
 * @param {import('express').Response} res
 */
export function removeClient(res) {
  clients.delete(res);
}

/**
 * Broadcast a named SSE event to every connected client.
 * @param {string} event  – SSE event name
 * @param {unknown} data  – will be JSON-serialised as the `data:` field
 */
export function broadcast(event, data) {
  if (clients.size === 0) return;
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) {
    try {
      res.write(payload);
    } catch {
      // If writing fails the client is gone; clean up.
      clients.delete(res);
    }
  }
}

export function clientCount() {
  return clients.size;
}
