// Server-Sent Events hub. Tracks active client connections and broadcasts
// seat-status transitions so every connected seat map stays live.

const clients = new Set();

export function addClient(res) {
  clients.add(res);
}

export function removeClient(res) {
  clients.delete(res);
}

export function clientCount() {
  return clients.size;
}

// Broadcast an event to all connected clients. `event` names the SSE event
// type; `data` is JSON-serialised.
export function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) {
    try {
      res.write(payload);
    } catch {
      // Drop broken connections silently; the close handler cleans up.
      clients.delete(res);
    }
  }
}

// Convenience: broadcast a set of seat changes. `seats` is an array of seat
// rows (effective view). The `reason` describes the transition kind.
export function broadcastSeatChanges(seats, reason) {
  if (!seats || seats.length === 0) return;
  broadcast('seats', { reason, seats });
}
