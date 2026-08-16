// Simple SSE connection registry. Every connected client gets an entry; we
// write `data:` frames to each. Clients are removed when their socket closes.

const clients = new Set();

export function addClient(res) {
  clients.add(res);
  return () => clients.delete(res);
}

/**
 * Broadcast an event to every connected client. `event` is the SSE event name,
 * `payload` is JSON-serialized as the data field.
 */
export function broadcast(event, payload) {
  const frame = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const res of clients) {
    try {
      res.write(frame);
    } catch {
      clients.delete(res);
    }
  }
}

export function clientCount() {
  return clients.size;
}
