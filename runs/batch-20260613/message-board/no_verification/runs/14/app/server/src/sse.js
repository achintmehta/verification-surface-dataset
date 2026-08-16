/**
 * Tracks active Server-Sent Events connections and provides a way to
 * broadcast messages to all of them.
 */

// Set of active response objects (one per connected client tab).
const clients = new Set();

/**
 * Register a new SSE client.
 * @param {import('express').Response} res
 */
export function addClient(res) {
  clients.add(res);
}

/**
 * Remove a client (e.g. on disconnect).
 * @param {import('express').Response} res
 */
export function removeClient(res) {
  clients.delete(res);
}

/**
 * Broadcast an event to every connected client.
 * @param {string} event - the SSE event name
 * @param {unknown} data - JSON-serializable payload
 */
export function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) {
    res.write(payload);
  }
}

export function clientCount() {
  return clients.size;
}
