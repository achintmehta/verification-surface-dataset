// Maintains the set of active SSE client connections and provides
// a broadcast helper. Each client is an Express response object kept
// open with the text/event-stream content type.

const clients = new Set();

export function addClient(res) {
  clients.add(res);
}

export function removeClient(res) {
  clients.delete(res);
}

/**
 * Broadcast an event to every connected client.
 * @param {string} event - SSE event name (e.g. 'card:created', 'card:moved')
 * @param {object} data - JSON-serializable payload
 */
export function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) {
    try {
      res.write(payload);
    } catch {
      // Drop broken connections silently; cleanup handled on 'close'.
      clients.delete(res);
    }
  }
}

export function clientCount() {
  return clients.size;
}
