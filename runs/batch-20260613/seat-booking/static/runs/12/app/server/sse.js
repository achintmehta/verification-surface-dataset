// Minimal Server-Sent Events hub. Tracks every connected client and broadcasts
// seat-status transitions so all seat maps stay live.

const clients = new Set();

export function addClient(res) {
  clients.add(res);
  res.on('close', () => clients.delete(res));
}

export function clientCount() {
  return clients.size;
}

// Broadcast an arbitrary event to all connected clients.
export function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) {
    try {
      res.write(payload);
    } catch {
      // If a write fails the client is gone; drop it.
      clients.delete(res);
    }
  }
}

// Broadcast a batch of seat transitions. `seats` is an array of effective seat
// rows (id, status, ...). Clients merge these into their local seat map.
export function broadcastSeatUpdates(seats) {
  if (!seats || seats.length === 0) return;
  broadcast('seats', { seats });
}
