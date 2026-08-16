// Minimal Server-Sent Events hub. Tracks active client connections and
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
 * Broadcast an event to every connected client. `type` becomes the SSE event
 * name; `data` is JSON-serialized.
 */
export function broadcast(type, data) {
  const payload = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of clients) {
    try {
      client.res.write(payload);
    } catch {
      removeClient(client);
    }
  }
}
