/**
 * Maintains a set of active SSE client connections and broadcasts
 * canonical mutation events to all of them.
 */
const clients = new Set();
let nextClientId = 1;

export function addClient(res) {
  const client = { id: nextClientId++, res };
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
 * @param {string} event - the SSE event name
 * @param {object} data  - JSON-serializable payload
 */
export function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of clients) {
    try {
      client.res.write(payload);
    } catch {
      clients.delete(client);
    }
  }
}
