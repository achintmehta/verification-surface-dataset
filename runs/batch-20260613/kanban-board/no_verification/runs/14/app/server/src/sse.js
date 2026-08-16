// A tiny Server-Sent Events hub. Holds open HTTP responses and writes
// formatted SSE events to all of them.

const clients = new Set();
let nextClientId = 1;

/**
 * Register a new SSE client. Returns a handle used to unregister it.
 * The caller is responsible for setting SSE headers on `res`.
 */
export function addClient(res) {
  const client = { id: nextClientId++, res };
  clients.add(client);
  return client;
}

export function removeClient(client) {
  clients.delete(client);
}

/**
 * Broadcast a named event with a JSON payload to every connected client.
 */
export function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of clients) {
    try {
      client.res.write(payload);
    } catch {
      // Connection is likely dead; it will be cleaned up on 'close'.
      clients.delete(client);
    }
  }
}

export function clientCount() {
  return clients.size;
}
