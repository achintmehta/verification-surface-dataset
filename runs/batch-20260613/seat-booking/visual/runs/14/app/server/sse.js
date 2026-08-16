// Simple SSE connection registry and broadcaster.

const clients = new Set();

export function addClient(res) {
  clients.add(res);
  res.on('close', () => {
    clients.delete(res);
  });
}

/**
 * Broadcast a seat-status transition event to all connected clients.
 * `seats` is an array of effective seat objects that changed.
 */
export function broadcast(type, payload) {
  const data = JSON.stringify({ type, payload, at: new Date().toISOString() });
  for (const res of clients) {
    try {
      res.write(`event: ${type}\n`);
      res.write(`data: ${data}\n\n`);
    } catch {
      clients.delete(res);
    }
  }
}

export function clientCount() {
  return clients.size;
}
