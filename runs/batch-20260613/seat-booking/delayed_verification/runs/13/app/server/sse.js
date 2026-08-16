// Server-Sent Events hub.
//
// Tracks every connected client and broadcasts seat-status transition events
// so that all open seat maps stay live.

const clients = new Set();

export function addClient(res) {
  clients.add(res);
  res.on('close', () => {
    clients.delete(res);
  });
}

// Broadcast a structured event to all connected clients.
// `event` is the SSE event name; `data` is any JSON-serializable payload.
export function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) {
    try {
      res.write(payload);
    } catch {
      // If a write fails the connection is dead; drop it.
      clients.delete(res);
    }
  }
}

// Convenience: broadcast a batch of seat updates as a single event.
// Each update is { id, status, holdId, holdExpiresAt, bookedBy }.
export function broadcastSeatUpdates(updates) {
  if (!updates || updates.length === 0) return;
  broadcast('seats', { seats: updates });
}

export function clientCount() {
  return clients.size;
}
