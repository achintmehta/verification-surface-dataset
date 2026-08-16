// Minimal Server-Sent Events hub. Holds open response objects and broadcasts
// seat-status transition events to all connected clients.

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

// Broadcast a structured event to every connected client.
// `event` is the SSE event name; `data` is JSON-serializable payload.
export function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) {
    try {
      res.write(payload);
    } catch {
      clients.delete(res);
    }
  }
}

// Convenience: broadcast a set of seat updates. `seats` is an array of
// { id, status, holdExpiresAt } reflecting the new effective state.
export function broadcastSeatUpdates(seats) {
  if (!seats || seats.length === 0) return;
  broadcast('seats', { seats });
}
