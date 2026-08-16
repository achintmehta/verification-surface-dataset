/**
 * SSE broadcast manager.
 * Keeps a set of active response objects and fans out events to all of them.
 */

const clients = new Set();

/**
 * Register a new SSE client.
 * @param {import('express').Response} res
 */
export function addClient(res) {
  clients.add(res);
}

/**
 * Remove a disconnected SSE client.
 * @param {import('express').Response} res
 */
export function removeClient(res) {
  clients.delete(res);
}

/**
 * Broadcast a seat-status event to every connected client.
 * @param {'held'|'booked'|'released'} type
 * @param {Array<{id: string, status: string, holdId?: string, sessionId?: string}>} seats
 */
export function broadcast(type, seats) {
  if (clients.size === 0) return;

  const payload = JSON.stringify({ type, seats, ts: Date.now() });
  const message = `event: seat-update\ndata: ${payload}\n\n`;

  for (const res of clients) {
    try {
      res.write(message);
    } catch {
      clients.delete(res);
    }
  }
}

export function clientCount() {
  return clients.size;
}
