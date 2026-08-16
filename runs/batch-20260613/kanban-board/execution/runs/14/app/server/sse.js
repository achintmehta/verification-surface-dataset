// Minimal Server-Sent Events hub.
// Holds open HTTP responses and broadcasts JSON events to every connected client.

const clients = new Set();

export function addClient(res) {
  clients.add(res);
  res.on('close', () => {
    clients.delete(res);
  });
}

export function clientCount() {
  return clients.size;
}

// Broadcast an event (named `type`) with a JSON payload to all connected clients.
export function broadcast(type, payload) {
  const data = JSON.stringify(payload);
  const frame = `event: ${type}\ndata: ${data}\n\n`;
  for (const res of clients) {
    try {
      res.write(frame);
    } catch {
      // If a write fails, the client is gone; it will be cleaned up on 'close'.
      clients.delete(res);
    }
  }
}
