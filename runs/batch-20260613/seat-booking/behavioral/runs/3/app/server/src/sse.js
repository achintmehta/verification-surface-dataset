/**
 * SSE (Server-Sent Events) broadcast module.
 *
 * Maintains a set of active SSE response objects and provides a `broadcast`
 * function that pushes seat-status events to every connected client.
 */

const clients = new Set();

/**
 * Register an SSE response object.
 * @param {import('express').Response} res
 */
export function addClient(res) {
  clients.add(res);
}

/**
 * Remove an SSE response object (called on connection close).
 * @param {import('express').Response} res
 */
export function removeClient(res) {
  clients.delete(res);
}

/**
 * Broadcast a seat-status event to all connected clients.
 *
 * @param {'held'|'booked'|'released'} eventType
 * @param {Array<{id: string, status: string, holdId?: string, bookedBy?: string}>} seats
 */
export function broadcast(eventType, seats) {
  if (clients.size === 0) return;

  const data = JSON.stringify({ type: eventType, seats, ts: Date.now() });
  const message = `event: seatUpdate\ndata: ${data}\n\n`;

  for (const res of clients) {
    try {
      res.write(message);
    } catch {
      // Client disconnected mid-write; remove it.
      clients.delete(res);
    }
  }
}

export function clientCount() {
  return clients.size;
}
