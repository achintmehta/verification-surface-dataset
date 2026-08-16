// Simple SSE connection registry. Each connected client owns one entry.
const clients = new Set();

let nextClientId = 1;

/**
 * Register a new SSE client (an Express response object configured for SSE).
 * Returns a function to remove the client when its connection closes.
 */
export function addClient(res) {
  const client = { id: nextClientId++, res };
  clients.add(client);
  return () => {
    clients.delete(client);
  };
}

/**
 * Broadcast an event to all connected SSE clients.
 * Only ever called with committed, canonical state.
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
