// Manages Server-Sent Events connections and broadcasts seat transitions.
let clients = new Set();
let nextId = 1;

export function addClient(res) {
  const id = nextId++;
  const client = { id, res };
  clients.add(client);
  return client;
}

export function removeClient(client) {
  clients.delete(client);
}

/**
 * Broadcast an event to all connected clients.
 * `event` shape: { type: 'held'|'booked'|'released', seats: [...] }
 */
export function broadcast(event) {
  const payload = `event: seats\ndata: ${JSON.stringify(event)}\n\n`;
  for (const client of clients) {
    try {
      client.res.write(payload);
    } catch (_e) {
      // Drop broken connections.
      clients.delete(client);
    }
  }
}

export function clientCount() {
  return clients.size;
}
