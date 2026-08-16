/**
 * SSE (Server-Sent Events) manager.
 * Maintains a set of active response streams and broadcasts seat-status events.
 */

const clients = new Set();

/**
 * Register a new SSE client response object.
 * @param {import('express').Response} res
 */
export function addClient(res) {
  clients.add(res);
}

/**
 * Remove a client (called on connection close).
 * @param {import('express').Response} res
 */
export function removeClient(res) {
  clients.delete(res);
}

/**
 * Broadcast a seat-update event to all connected clients.
 * @param {Array<{id: string, status: string, holdId?: string|null, holdExpiresAt?: string|null, bookedBy?: string|null}>} seats
 */
export function broadcastSeatUpdate(seats) {
  if (clients.size === 0) return;

  const payload = JSON.stringify(seats);
  const message = `event: seat-update\ndata: ${payload}\n\n`;

  for (const res of clients) {
    try {
      res.write(message);
    } catch (err) {
      // Client disconnected mid-write; remove it
      clients.delete(res);
    }
  }
}

/**
 * Returns the current number of connected SSE clients.
 */
export function clientCount() {
  return clients.size;
}
