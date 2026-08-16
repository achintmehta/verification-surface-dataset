// Server-Sent Events hub. Keeps a set of active client connections and
// broadcasts seat-status transition events so every seat map stays live.

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

// Broadcast an arbitrary named event with a JSON payload to all clients.
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

// Convenience helper: broadcast a batch of seat transitions. Each entry is a
// full seat object as the clients expect it (id + effective status fields).
export function broadcastSeatChanges(seats) {
  if (!seats || seats.length === 0) return;
  broadcast('seats', { seats });
}
