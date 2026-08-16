// Simple in-memory SSE connection registry + broadcaster.
let nextId = 1;
const clients = new Map(); // id -> res

export function addClient(res) {
  const id = nextId++;
  clients.set(id, res);
  return id;
}

export function removeClient(id) {
  clients.delete(id);
}

export function clientCount() {
  return clients.size;
}

/**
 * Broadcast an event to all connected clients.
 * @param {string} type  Event name (used as SSE `event:`).
 * @param {object} data  JSON-serialisable payload.
 */
export function broadcast(type, data) {
  const payload = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const [id, res] of clients) {
    try {
      res.write(payload);
    } catch {
      clients.delete(id);
    }
  }
}
