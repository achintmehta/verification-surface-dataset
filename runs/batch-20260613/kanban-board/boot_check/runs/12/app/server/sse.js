/**
 * Minimal SSE (Server-Sent Events) hub.
 * Keeps track of all connected clients and broadcasts canonical events.
 */

const clients = new Set();
let nextClientId = 1;

/**
 * Register a new SSE client. Express `res` must already have SSE headers set.
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
 * Broadcast an event to every connected client.
 * @param {string} event - SSE event name (e.g. 'card:create', 'card:move', 'column:reorder').
 * @param {object} data  - JSON-serializable payload.
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

export function clientCount() {
  return clients.size;
}
