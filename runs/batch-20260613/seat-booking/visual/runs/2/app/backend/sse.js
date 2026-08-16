// SSE connection manager and broadcaster

const clients = new Set();

/**
 * Register a new SSE client response object.
 */
export function addClient(res) {
  clients.add(res);
}

/**
 * Remove a disconnected SSE client.
 */
export function removeClient(res) {
  clients.delete(res);
}

/**
 * Broadcast a seat-status event to all connected clients.
 * @param {string} eventType - e.g. 'seat_held', 'seat_booked', 'seat_released'
 * @param {object} data - payload to JSON-serialize
 */
export function broadcast(eventType, data) {
  const payload = `event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) {
    try {
      res.write(payload);
    } catch (err) {
      // Client disconnected mid-write; remove it
      clients.delete(res);
    }
  }
}

/**
 * Broadcast multiple seat updates at once.
 * @param {Array<{id, status, holdId?, expiresAt?, bookedBy?}>} seats
 * @param {string} eventType
 */
export function broadcastSeats(seats, eventType) {
  if (!seats || seats.length === 0) return;
  broadcast(eventType, { seats });
}
