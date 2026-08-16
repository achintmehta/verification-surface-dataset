/**
 * In-memory registry of active SSE client response objects.
 * Each entry is a plain Express `res` object that has already had
 * the SSE headers written to it.
 */
const clients = new Set();

/**
 * Register a new SSE client.
 * @param {import('express').Response} res
 */
export function addClient(res) {
  clients.add(res);
  console.log(`[sse] client connected  – total: ${clients.size}`);
}

/**
 * Remove an SSE client (called when the connection closes).
 * @param {import('express').Response} res
 */
export function removeClient(res) {
  clients.delete(res);
  console.log(`[sse] client disconnected – total: ${clients.size}`);
}

/**
 * Broadcast a JSON-serialisable payload to every connected SSE client.
 * Uses the standard `data:` field with a trailing double-newline.
 *
 * @param {string} event  – SSE event name (e.g. "message")
 * @param {unknown} data  – payload; will be JSON-stringified
 */
export function broadcast(event, data) {
  const chunk = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) {
    res.write(chunk);
  }
  console.log(`[sse] broadcast "${event}" to ${clients.size} client(s)`);
}
