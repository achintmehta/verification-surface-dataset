/**
 * sseManager.js
 * Manages the set of active Server-Sent Event (SSE) client connections and
 * provides a broadcast helper that pushes a JSON payload to every connected
 * client simultaneously.
 */

/** @type {Set<import('express').Response>} */
const clients = new Set();

/**
 * Registers a new SSE response object so it receives future broadcasts.
 *
 * @param {import('express').Response} res - The Express response object that
 *   has already been configured with the correct SSE headers.
 */
export function addClient(res) {
  clients.add(res);
  console.log(`[sse] Client connected  – total: ${clients.size}`);
}

/**
 * Removes a client from the active set (called when the connection closes).
 *
 * @param {import('express').Response} res
 */
export function removeClient(res) {
  clients.delete(res);
  console.log(`[sse] Client disconnected – total: ${clients.size}`);
}

/**
 * Serialises `data` as JSON and writes an SSE `data:` frame to every active
 * client.  Clients that have already closed are silently skipped.
 *
 * @param {string} eventName - The SSE event name (e.g. `"new-message"`).
 * @param {unknown} data     - Any JSON-serialisable value.
 */
export function broadcast(eventName, data) {
  const payload = `event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) {
    try {
      res.write(payload);
    } catch {
      // The socket may have closed between the check and the write; remove it.
      clients.delete(res);
    }
  }
  console.log(`[sse] Broadcast "${eventName}" to ${clients.size} client(s)`);
}
