/**
 * SSE (Server-Sent Events) broadcaster.
 * Maintains a set of active response objects and broadcasts seat-status events.
 */

const clients = new Set();

/**
 * Add a new SSE client connection.
 * @param {import('express').Response} res
 */
export function addClient(res) {
  clients.add(res);
}

/**
 * Remove an SSE client connection.
 * @param {import('express').Response} res
 */
export function removeClient(res) {
  clients.delete(res);
}

/**
 * Broadcast a seat-status event to all connected clients.
 * @param {string} eventType - e.g. 'seat_update'
 * @param {object} data
 */
export function broadcast(eventType, data) {
  const payload = `event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) {
    try {
      res.write(payload);
    } catch (err) {
      // Client disconnected; will be cleaned up via 'close' event
      clients.delete(res);
    }
  }
}

/**
 * Broadcast multiple seat updates at once.
 * @param {Array<{id: string, status: string, hold_id?: string, booked_by?: string}>} seats
 */
export function broadcastSeatUpdates(seats) {
  if (!seats || seats.length === 0) return;
  broadcast('seat_update', { seats });
}
