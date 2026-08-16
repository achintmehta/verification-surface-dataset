/**
 * sse.js – Server-Sent Events broadcast hub.
 *
 * Every seat status transition is broadcast to all connected clients so
 * every seat map stays live without polling.
 */

const clients = new Set();

/**
 * Register an SSE response object.
 * Returns an unsubscribe function.
 */
export function addClient(res) {
  clients.add(res);
  return () => clients.delete(res);
}

/**
 * Broadcast a JSON payload to every connected client.
 *
 * @param {string} event  – SSE event name
 * @param {object} data   – payload (will be JSON-serialised)
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
 * Number of currently connected SSE clients (useful for diagnostics).
 */
export function clientCount() {
  return clients.size;
}
