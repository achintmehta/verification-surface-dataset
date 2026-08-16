/**
 * SSE (Server-Sent Events) module.
 * Maintains a registry of active SSE connections and provides a broadcast helper.
 */

const clients = new Set();

/**
 * Register an SSE response object.
 * @param {import('express').Response} res
 */
export function addClient(res) {
  clients.add(res);
}

/**
 * Remove an SSE response object (on disconnect).
 * @param {import('express').Response} res
 */
export function removeClient(res) {
  clients.delete(res);
}

/**
 * Broadcast a named event with a JSON payload to all connected clients.
 * @param {string} event  - SSE event name
 * @param {object} data   - payload (will be JSON-serialised)
 */
export function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) {
    try {
      res.write(payload);
    } catch {
      clients.delete(res);
    }
  }
}

/**
 * Number of currently connected SSE clients.
 */
export function clientCount() {
  return clients.size;
}
