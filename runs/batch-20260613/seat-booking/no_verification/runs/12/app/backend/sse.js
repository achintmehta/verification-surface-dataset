/**
 * Maintains the set of active Server-Sent Events connections and broadcasts
 * seat status transitions to every connected client.
 */

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
 * Broadcast an event to all connected clients.
 * @param {string} event - event name (e.g. 'seats-changed')
 * @param {object} data  - JSON-serializable payload
 */
export function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of clients) {
    try {
      client.res.write(payload);
    } catch (err) {
      // Drop broken connections.
      clients.delete(client);
    }
  }
}

/**
 * Broadcast a batch of seat transitions. Each entry describes a seat's new
 * effective state so clients can update their seat map live.
 * @param {Array<{seat: object, transition: string}>} changes
 */
export function broadcastSeatChanges(changes) {
  if (!changes || changes.length === 0) return;
  broadcast('seats-changed', { changes, at: new Date().toISOString() });
}
