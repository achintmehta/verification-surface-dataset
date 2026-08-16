// Server-Sent Events hub. Maintains the set of connected clients and pushes
// seat-status transitions to all of them.

export function createSSEHub() {
  const clients = new Set();

  function addClient(res) {
    clients.add(res);
    res.on('close', () => clients.delete(res));
  }

  function broadcast(event, data) {
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
   * Broadcast a batch of seat transitions. `seats` is an array of
   * { id, status, ... } and `released` is a list of seat ids freed by expiry.
   */
  function broadcastSeatUpdate(seats = [], released = []) {
    if (seats.length === 0 && released.length === 0) return;
    broadcast('seats', { seats, released, ts: Date.now() });
  }

  function clientCount() {
    return clients.size;
  }

  return { addClient, broadcast, broadcastSeatUpdate, clientCount };
}
