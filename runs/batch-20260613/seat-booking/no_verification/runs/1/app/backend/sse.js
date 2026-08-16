/**
 * SSE broadcaster – keeps a set of active response objects and
 * pushes named events to all of them.
 */

const clients = new Set();

/**
 * Register an SSE client (Express res object).
 * Returns an unsubscribe function.
 */
export function addClient(res) {
  clients.add(res);
  return () => clients.delete(res);
}

/**
 * Broadcast a named event with a JSON payload to every connected client.
 * @param {string} event  – SSE event name
 * @param {object} data   – will be JSON-serialised
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
