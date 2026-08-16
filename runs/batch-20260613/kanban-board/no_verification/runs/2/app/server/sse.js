/**
 * SSE (Server-Sent Events) manager.
 * Maintains the set of active client connections and provides
 * a broadcast helper used by mutation handlers.
 */

const clients = new Set();

/**
 * Register an SSE response object and return a cleanup function.
 * @param {import('express').Response} res
 * @returns {() => void} cleanup
 */
export function addClient(res) {
  clients.add(res);
  return () => clients.delete(res);
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

export function clientCount() {
  return clients.size;
}
