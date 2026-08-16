/**
 * Server-Sent Events (SSE) broadcaster.
 *
 * Maintains a registry of active SSE response objects and provides a
 * broadcast helper that pushes seat-status change events to every
 * connected client.
 */

/** @type {Set<import('express').Response>} */
const clients = new Set();

/**
 * Register an SSE client response and return a cleanup function.
 *
 * @param {import('express').Response} res
 * @returns {() => void} cleanup
 */
export function addClient(res) {
  clients.add(res);
  return () => clients.delete(res);
}

/**
 * Broadcast a seat-status event to all connected SSE clients.
 *
 * @param {'held'|'booked'|'released'} eventType
 * @param {Array<{id: string, status: string, holdId?: string|null, bookedBy?: string|null, holdExpiresAt?: string|null}>} seats
 */
export function broadcast(eventType, seats) {
  if (clients.size === 0) return;

  const payload = JSON.stringify({ type: eventType, seats, ts: Date.now() });
  const message = `event: seat-update\ndata: ${payload}\n\n`;

  for (const res of clients) {
    try {
      res.write(message);
    } catch {
      // Client disconnected mid-write; the close handler will clean it up.
    }
  }
}

/**
 * Return the current number of connected SSE clients (useful for health checks).
 */
export function clientCount() {
  return clients.size;
}
