// Manages active Server-Sent Events connections and broadcasts seat-status
// transitions to every connected client so all seat maps stay live.

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

// Broadcast an arbitrary event to all connected clients.
export function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) {
    try {
      res.write(payload);
    } catch (_e) {
      // Best-effort; the 'close' handler removes dead connections.
    }
  }
}

// Convenience helper for broadcasting a batch of seat transitions.
// `seats` is an array of seat objects (effective view).
export function broadcastSeatUpdate(seats) {
  if (!seats || seats.length === 0) return;
  broadcast('seats-updated', { seats });
}
