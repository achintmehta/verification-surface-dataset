// Simple SSE connection registry + broadcaster.

const clients = new Set();

export function addClient(res) {
  clients.add(res);
  res.on('close', () => clients.delete(res));
}

export function clientCount() {
  return clients.size;
}

/**
 * Broadcast an event to all connected clients.
 * @param {string} type  event name
 * @param {object} data  JSON-serializable payload
 */
export function broadcast(type, data) {
  const payload = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) {
    try {
      res.write(payload);
    } catch {
      clients.delete(res);
    }
  }
}

/**
 * Broadcast seat transitions. `seats` is an array of effective seat objects;
 * we send the minimal status info needed for clients to update.
 */
export function broadcastSeatUpdates(seats) {
  if (!seats || seats.length === 0) return;
  broadcast('seats', {
    seats: seats.map((s) => ({
      id: s.id,
      status: s.status,
      holdId: s.holdId ?? null,
      holdExpiresAt: s.holdExpiresAt ?? null,
      bookedBy: s.bookedBy ?? null,
    })),
  });
}
