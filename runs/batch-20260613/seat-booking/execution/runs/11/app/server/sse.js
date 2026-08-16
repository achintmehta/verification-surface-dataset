// Server-Sent Events hub: keeps track of connected clients and broadcasts
// seat-status transitions so every connected seat map stays live.

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

/**
 * Broadcast a list of seat updates to all connected clients.
 * Each update is the effective seat state after a transition.
 * type is one of: 'held', 'booked', 'released'.
 */
export function broadcast(event) {
  const payload = `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
  for (const res of clients) {
    try {
      res.write(payload);
    } catch {
      clients.delete(res);
    }
  }
}
