/**
 * SSE (Server-Sent Events) connection registry.
 *
 * Clients connect to GET /api/stream and receive a persistent text/event-stream
 * response.  Every mutation broadcasts a JSON event to all live connections.
 *
 * Event shapes
 * ─────────────
 *   type: "card:created"  – payload: { card }
 *   type: "card:moved"    – payload: { card }
 *   type: "column:reorder"– payload: { columnId, cards }   (after renormalisation)
 *   type: "board:init"    – payload: { columns }            (sent once on connect)
 */

const clients = new Set();

/**
 * Register an SSE response object and return a cleanup function.
 * @param {import('express').Response} res
 * @returns {() => void} cleanup
 */
export function addClient(res) {
  clients.add(res);
  return () => clients.delete(res);
}

/**
 * Broadcast a typed event to every connected client.
 * @param {string} type   – event name
 * @param {object} payload
 */
export function broadcast(type, payload) {
  const data = JSON.stringify({ type, payload });
  const message = `event: ${type}\ndata: ${data}\n\n`;
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
