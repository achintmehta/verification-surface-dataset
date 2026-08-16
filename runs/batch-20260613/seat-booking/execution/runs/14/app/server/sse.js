// Simple Server-Sent Events hub. Tracks connected clients and broadcasts
// seat-status transition events so every seat map stays live.

const clients = new Set();

/**
 * Register a new SSE client (an Express response object configured for SSE).
 */
export function addClient(res) {
  clients.add(res);
  res.on('close', () => clients.delete(res));
}

export function clientCount() {
  return clients.size;
}

/**
 * Broadcast an event to all connected clients.
 * @param {string} event - event name (e.g. 'seats').
 * @param {object} data - JSON-serializable payload.
 */
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

/**
 * Broadcast a batch of seat transitions. Each item is a full seat record
 * (effective status) so clients can update without a refetch.
 */
export function broadcastSeats(seats) {
  if (!seats || seats.length === 0) return;
  broadcast('seats', { seats });
}
