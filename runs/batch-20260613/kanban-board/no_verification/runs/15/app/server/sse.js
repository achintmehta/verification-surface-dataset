/**
 * Tracks active Server-Sent Events connections and broadcasts events to all.
 */
const clients = new Set();

export function addClient(res) {
  clients.add(res);
}

export function removeClient(res) {
  clients.delete(res);
}

/**
 * Broadcast an event with a given `type` and JSON-serializable `payload`
 * to every connected client.
 */
export function broadcast(type, payload) {
  const data = JSON.stringify(payload);
  const message = `event: ${type}\ndata: ${data}\n\n`;
  for (const res of clients) {
    try {
      res.write(message);
    } catch {
      // Client likely disconnected; it will be cleaned up by 'close'.
      clients.delete(res);
    }
  }
}

export function clientCount() {
  return clients.size;
}
