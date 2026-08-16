/**
 * SSE (Server-Sent Events) broadcast module.
 *
 * Maintains a registry of active SSE response objects and provides a
 * `broadcast` helper that serialises an event to every connected client.
 *
 * Event shape sent to clients:
 *   event: seatUpdate
 *   data: JSON array of seat objects whose status just changed
 *
 * Each seat object in the array has the shape returned by GET /api/seats.
 */

/** @type {Set<import('express').Response>} */
const clients = new Set();

/**
 * Register an SSE client response.  The caller is responsible for setting
 * the correct headers before calling this.
 *
 * @param {import('express').Response} res
 */
export function addClient(res) {
  clients.add(res);
}

/**
 * Remove an SSE client (called when the connection closes).
 *
 * @param {import('express').Response} res
 */
export function removeClient(res) {
  clients.delete(res);
}

/**
 * Broadcast a seat-update event to every connected SSE client.
 *
 * @param {object[]} seats  Array of seat objects that changed.
 */
export function broadcast(seats) {
  if (!seats || seats.length === 0) return;

  const payload = `event: seatUpdate\ndata: ${JSON.stringify(seats)}\n\n`;

  for (const res of clients) {
    try {
      res.write(payload);
    } catch {
      // Client disconnected mid-write; remove it.
      clients.delete(res);
    }
  }
}

/**
 * Return the number of currently connected SSE clients (useful for health
 * checks / debugging).
 */
export function clientCount() {
  return clients.size;
}
