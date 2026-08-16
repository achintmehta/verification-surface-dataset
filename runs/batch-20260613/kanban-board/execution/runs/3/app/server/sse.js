/**
 * SSE (Server-Sent Events) connection manager.
 * Maintains a set of active response streams and provides a broadcast helper.
 */

const clients = new Set();

/**
 * Register an SSE client.
 * @param {import('express').Response} res
 */
export function addClient(res) {
  clients.add(res);
  console.log(`[sse] client connected  (total: ${clients.size})`);
}

/**
 * Remove an SSE client.
 * @param {import('express').Response} res
 */
export function removeClient(res) {
  clients.delete(res);
  console.log(`[sse] client disconnected (total: ${clients.size})`);
}

/**
 * Broadcast an event to all connected SSE clients.
 * @param {string} event  - SSE event name
 * @param {object} data   - JSON-serialisable payload
 */
export function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) {
    try {
      res.write(payload);
    } catch (err) {
      console.error('[sse] write error, removing client', err.message);
      clients.delete(res);
    }
  }
}
