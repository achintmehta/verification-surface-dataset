/**
 * In-memory registry of active SSE response objects.
 * Each entry is a plain Node.js / Express `res` object that has already
 * had the SSE headers written to it and is kept open.
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
 * Uses the standard `data:` SSE field followed by two newlines.
 *
 * @param {string} event  – SSE event name (e.g. "message")
 * @param {object} payload – data to serialise as JSON
 */
export function broadcast(event, payload) {
  const chunk = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const res of clients) {
    res.write(chunk);
  }
  console.log(`[sse] broadcast "${event}" to ${clients.size} client(s)`);
}
