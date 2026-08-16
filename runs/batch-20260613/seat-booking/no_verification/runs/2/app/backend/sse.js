/**
 * SSE broadcast manager.
 * Keeps a set of active response objects and fans out events to all of them.
 */

const clients = new Set();

/**
 * Register a new SSE client (an Express res object already configured for SSE).
 * Returns a cleanup function to call when the connection closes.
 */
export function addClient(res) {
  clients.add(res);
  return () => clients.delete(res);
}

/**
 * Broadcast a named event with a JSON payload to every connected client.
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

export function clientCount() {
  return clients.size;
}
