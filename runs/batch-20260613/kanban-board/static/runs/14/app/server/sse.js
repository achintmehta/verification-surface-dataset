// Minimal Server-Sent Events hub: tracks open client connections and
// broadcasts JSON events to all of them.

const clients = new Set();
let nextClientId = 1;

/**
 * Registers a new SSE client. Expects an Express `res` with headers already
 * suitable for SSE. Returns an unsubscribe function.
 */
export function addClient(res) {
  const id = nextClientId++;
  const client = { id, res };
  clients.add(client);

  return () => {
    clients.delete(client);
  };
}

/**
 * Broadcasts an event to every connected client.
 * @param {string} event - the SSE event name (e.g. "card:created").
 * @param {object} data - JSON-serializable payload.
 */
export function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of clients) {
    try {
      client.res.write(payload);
    } catch {
      // If a write fails, drop the client; its close handler will also fire.
      clients.delete(client);
    }
  }
}

export function clientCount() {
  return clients.size;
}
