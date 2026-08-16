/**
 * SSE connection manager.
 * Maintains a set of active response objects and broadcasts seat status events.
 */

/** @type {Set<import('express').Response>} */
const clients = new Set();

/**
 * Register a new SSE client.
 * @param {import('express').Request} _req
 * @param {import('express').Response} res
 */
export function addClient(_req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  // Send an initial comment to flush headers
  res.write(':ok\n\n');
  clients.add(res);

  // Remove on close
  res.on('close', () => {
    clients.delete(res);
  });
}

/**
 * Broadcast a seat-status-change event to all connected clients.
 * @param {Array<{id: number, row_label: string, seat_number: number, status: string, hold_id: string|null, hold_expires_at: string|null, booked_by: string|null}>} seats
 * @param {string} eventType - e.g. "seat-update"
 */
export function broadcast(seats, eventType = 'seat-update') {
  const data = JSON.stringify(seats);
  const message = `event: ${eventType}\ndata: ${data}\n\n`;
  for (const client of clients) {
    client.write(message);
  }
}

/**
 * Return the number of active SSE connections.
 * @returns {number}
 */
export function clientCount() {
  return clients.size;
}
