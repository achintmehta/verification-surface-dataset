// Simple SSE connection registry + broadcaster.
const clients = new Set();

let nextClientId = 1;

/**
 * Register a new SSE client (an Express response object that has had SSE
 * headers written). Returns a cleanup function to call on disconnect.
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
 * Broadcast an event to every connected client.
 * @param {string} type - SSE event name (e.g. 'card-created', 'card-moved').
 * @param {object} payload - JSON-serializable payload.
 */
export function broadcast(type, payload) {
  const data = JSON.stringify(payload);
  for (const client of clients) {
    try {
      client.res.write(`event: ${type}\n`);
      client.res.write(`data: ${data}\n\n`);
    } catch {
      clients.delete(client);
    }
  }
}

export function clientCount() {
  return clients.size;
}
