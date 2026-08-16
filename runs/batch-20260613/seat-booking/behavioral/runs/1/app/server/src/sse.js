/**
 * SSE (Server-Sent Events) module.
 *
 * Maintains a registry of active SSE connections and provides a broadcast
 * helper that pushes seat-status events to every connected client.
 */

const clients = new Set();

/**
 * Register an SSE response object and clean it up when the connection closes.
 */
export function addClient(res) {
  clients.add(res);
  res.on('close', () => clients.delete(res));
}

/**
 * Broadcast a seat-status event to all connected clients.
 *
 * @param {string} eventType  - e.g. 'seat-held', 'seat-booked', 'seat-released'
 * @param {object|object[]} data - seat object(s) to send
 */
export function broadcast(eventType, data) {
  const payload = JSON.stringify(Array.isArray(data) ? data : [data]);
  const message = `event: ${eventType}\ndata: ${payload}\n\n`;

  for (const res of clients) {
    try {
      res.write(message);
    } catch {
      clients.delete(res);
    }
  }
}

export function clientCount() {
  return clients.size;
}
