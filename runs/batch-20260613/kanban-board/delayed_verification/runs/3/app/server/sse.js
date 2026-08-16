/**
 * SSE (Server-Sent Events) manager.
 *
 * Maintains the set of active SSE connections and provides a broadcast
 * helper used by mutation handlers to push canonical state to all clients.
 */

const clients = new Set();

/**
 * Register an SSE response object and clean it up when the connection closes.
 * @param {import('express').Response} res
 */
export function addClient(res) {
  clients.add(res);
  res.on('close', () => clients.delete(res));
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
      // If writing fails the 'close' handler will remove the client.
    }
  }
}

export function clientCount() {
  return clients.size;
}
