// Simple Server-Sent Events hub: tracks open client connections and
// broadcasts JSON events to all of them.

const clients = new Set();
let nextId = 1;

export function addClient(res) {
  const client = { id: nextId++, res };
  clients.add(client);
  return client;
}

export function removeClient(client) {
  clients.delete(client);
}

export function clientCount() {
  return clients.size;
}

/**
 * Broadcast an event to every connected client.
 * @param {string} event - SSE event name (e.g. 'card:create', 'card:move')
 * @param {object} data - JSON-serializable payload
 */
export function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of clients) {
    try {
      client.res.write(payload);
    } catch {
      removeClient(client);
    }
  }
}
