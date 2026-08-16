/**
 * Maintains the set of active SSE client connections and provides a broadcast
 * helper. Each event is JSON-encoded with a `type` and `data` payload.
 */
const clients = new Set();
let nextClientId = 1;

export function addClient(res) {
  const id = nextClientId++;
  const client = { id, res };
  clients.add(client);

  // Tell the client to retry after 3s if the connection drops.
  res.write('retry: 3000\n\n');
  // Initial comment to open the stream promptly.
  res.write(': connected\n\n');

  return client;
}

export function removeClient(client) {
  clients.delete(client);
}

/**
 * Broadcasts an event to every connected client. Dead connections are pruned.
 */
export function broadcast(type, data) {
  const payload = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of clients) {
    try {
      client.res.write(payload);
    } catch {
      clients.delete(client);
    }
  }
}

export function clientCount() {
  return clients.size;
}
