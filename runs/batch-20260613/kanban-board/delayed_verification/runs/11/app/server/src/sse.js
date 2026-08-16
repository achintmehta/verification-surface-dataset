/**
 * Maintains the set of active SSE connections and broadcasts events to all.
 */
const clients = new Set();

export function addClient(res) {
  clients.add(res);
}

export function removeClient(res) {
  clients.delete(res);
}

export function clientCount() {
  return clients.size;
}

/**
 * Broadcast an event to every connected client.
 * @param {string} event - SSE event name.
 * @param {object} data - JSON-serializable payload.
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
