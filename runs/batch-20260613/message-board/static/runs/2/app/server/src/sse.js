/**
 * In-memory registry of active SSE client connections.
 *
 * Each entry is an Express Response object that has already been configured
 * with the correct SSE headers.
 */
const clients = new Set();

/**
 * Register a new SSE client.
 *
 * @param {import('express').Response} res - The Express response object.
 */
export function addClient(res) {
  clients.add(res);
  console.log(`[sse] client connected  – total: ${clients.size}`);
}

/**
 * Remove an SSE client (called when the connection closes).
 *
 * @param {import('express').Response} res - The Express response object.
 */
export function removeClient(res) {
  clients.delete(res);
  console.log(`[sse] client disconnected – total: ${clients.size}`);
}

/**
 * Broadcast a named SSE event carrying a JSON payload to every connected
 * client.
 *
 * @param {string} event - The SSE event name (e.g. "message").
 * @param {unknown} data  - Any JSON-serialisable value.
 */
export function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) {
    res.write(payload);
  }
}
