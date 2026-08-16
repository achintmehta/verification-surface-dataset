/**
 * In-memory registry of active SSE response objects.
 * Each entry is a plain Node.js / Express `res` object that has already
 * had its SSE headers written.
 */
const clients = new Set();

/**
 * Register a new SSE client connection.
 * @param {import('express').Response} res
 */
export function addClient(res) {
  clients.add(res);
  console.log(`[sse] client connected  – total: ${clients.size}`);
}

/**
 * Remove a client (called when the connection closes).
 * @param {import('express').Response} res
 */
export function removeClient(res) {
  clients.delete(res);
  console.log(`[sse] client disconnected – total: ${clients.size}`);
}

/**
 * Broadcast a JSON-serialisable payload to every connected SSE client.
 * Uses the standard `data: ...\n\n` SSE wire format.
 *
 * @param {string} eventName  – the SSE event name (e.g. "new-message")
 * @param {object} payload    – will be JSON-stringified into the data field
 */
export function broadcast(eventName, payload) {
  const chunk = `event: ${eventName}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const res of clients) {
    res.write(chunk);
  }
  console.log(`[sse] broadcast "${eventName}" to ${clients.size} client(s)`);
}
