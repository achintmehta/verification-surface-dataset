/**
 * Server-Sent Events broadcaster.
 * Maintains a set of active SSE response objects and fans out events to all of them.
 */

const clients = new Set();

/**
 * Register a new SSE client response.
 * @param {import('express').Response} res
 */
export function addClient(res) {
  clients.add(res);
}

/**
 * Remove an SSE client response (called on connection close).
 * @param {import('express').Response} res
 */
export function removeClient(res) {
  clients.delete(res);
}

/**
 * Broadcast a seat-status event to all connected clients.
 * @param {'held'|'booked'|'released'} eventType
 * @param {Array<{id: string, status: string, holdId?: string, sessionId?: string}>} seats
 */
export function broadcast(eventType, seats) {
  if (clients.size === 0) return;
  const payload = JSON.stringify({ type: eventType, seats, ts: Date.now() });
  const message = `event: seat-update\ndata: ${payload}\n\n`;
  for (const res of clients) {
    try {
      res.write(message);
    } catch {
      // Client disconnected mid-write; will be cleaned up on 'close'
      clients.delete(res);
    }
  }
}

export function clientCount() {
  return clients.size;
}
