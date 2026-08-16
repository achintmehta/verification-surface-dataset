/**
 * SSE (Server-Sent Events) manager.
 * Maintains a set of active response streams and broadcasts seat-status events.
 */

const clients = new Set();

/**
 * Add a new SSE client connection.
 * @param {import('express').Response} res
 */
export function addClient(res) {
  clients.add(res);
  console.log(`[SSE] Client connected. Total: ${clients.size}`);
}

/**
 * Remove an SSE client connection.
 * @param {import('express').Response} res
 */
export function removeClient(res) {
  clients.delete(res);
  console.log(`[SSE] Client disconnected. Total: ${clients.size}`);
}

/**
 * Broadcast a seat-status event to all connected clients.
 * @param {string} eventType - 'held' | 'booked' | 'released'
 * @param {Array<{id: string, status: string, holdId?: string, expiresAt?: string, bookedBy?: string}>} seats
 */
export function broadcastSeatUpdate(eventType, seats) {
  if (clients.size === 0) return;

  const payload = JSON.stringify({ type: eventType, seats, timestamp: Date.now() });
  const message = `event: seatUpdate\ndata: ${payload}\n\n`;

  const dead = [];
  for (const res of clients) {
    try {
      res.write(message);
    } catch (err) {
      dead.push(res);
    }
  }
  // Clean up dead connections
  for (const res of dead) {
    clients.delete(res);
  }

  if (seats.length > 0) {
    console.log(`[SSE] Broadcast '${eventType}' for ${seats.length} seat(s): ${seats.map(s => s.id).join(', ')}`);
  }
}

/**
 * Send a heartbeat to all clients to keep connections alive.
 */
export function heartbeat() {
  const message = `: heartbeat\n\n`;
  const dead = [];
  for (const res of clients) {
    try {
      res.write(message);
    } catch (err) {
      dead.push(res);
    }
  }
  for (const res of dead) {
    clients.delete(res);
  }
}
