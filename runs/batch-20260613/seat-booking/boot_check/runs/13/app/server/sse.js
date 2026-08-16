// Simple SSE hub for broadcasting seat status transitions.

const clients = new Set();

export function addClient(res) {
  clients.add(res);
}

export function removeClient(res) {
  clients.delete(res);
}

export function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) {
    try {
      res.write(payload);
    } catch (e) {
      // ignore broken pipes; cleanup happens on close
    }
  }
}

// Broadcast a list of seat transitions: [{ id, status, ... }]
export function broadcastSeatUpdates(seats) {
  if (!seats || seats.length === 0) return;
  broadcast('seats', { seats });
}
