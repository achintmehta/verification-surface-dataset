/** @typedef {import('express').Response} Response */

/** @type {Set<Response>} */
const clients = new Set();

/**
 * Add an SSE client connection.
 * @param {Response} res
 */
export function addClient(res) {
  clients.add(res);
}

/**
 * Remove an SSE client connection.
 * @param {Response} res
 */
export function removeClient(res) {
  clients.delete(res);
}

/**
 * Broadcast a seat update event to all connected SSE clients.
 * @param {Array<{id: number, row_label: string, seat_number: number, status: string, hold_id: string|null, hold_expires_at: string|null}>} seats
 */
export function broadcastSeatUpdate(seats) {
  if (seats.length === 0) return;

  const data = JSON.stringify({
    type: "seat_update",
    seats,
    timestamp: new Date().toISOString(),
  });

  const message = `data: ${data}\n\n`;

  for (const client of clients) {
    try {
      client.write(message);
    } catch (_err) {
      clients.delete(client);
    }
  }
}

/**
 * Get the number of connected SSE clients.
 * @returns {number}
 */
export function getClientCount() {
  return clients.size;
}
