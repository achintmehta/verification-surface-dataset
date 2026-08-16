/**
 * SSE Connection Manager
 *
 * Keeps track of every active Server-Sent Events response object and
 * provides a single broadcast() helper that fans a message out to all
 * currently connected clients.
 */

/** @type {Set<import('express').Response>} */
const clients = new Set();

/**
 * Register a new SSE client response.
 * The caller is responsible for setting the appropriate headers before
 * calling this function.
 *
 * @param {import('express').Response} res
 */
export function addClient(res) {
  clients.add(res);
  console.log(`[sse] client connected  – total: ${clients.size}`);
}

/**
 * Remove a client (e.g. when the connection is closed).
 *
 * @param {import('express').Response} res
 */
export function removeClient(res) {
  clients.delete(res);
  console.log(`[sse] client disconnected – total: ${clients.size}`);
}

/**
 * Broadcast a named SSE event carrying a JSON payload to every connected
 * client.
 *
 * The SSE wire format is:
 *   event: <name>\n
 *   data: <json>\n
 *   \n
 *
 * @param {string} event  - The SSE event name (e.g. "new-message")
 * @param {unknown} data  - Any JSON-serialisable value
 */
export function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) {
    res.write(payload);
  }
  console.log(`[sse] broadcast "${event}" to ${clients.size} client(s)`);
}
