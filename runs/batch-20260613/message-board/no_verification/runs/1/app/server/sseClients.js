/**
 * In-memory registry of active SSE client response objects.
 * Each entry is a Node.js ServerResponse that has already had
 * the SSE headers written to it.
 */
const clients = new Set();

/**
 * Register a new SSE client.
 * @param {import('http').ServerResponse} res
 */
export function addClient(res) {
  clients.add(res);
  console.log(`[sse] client connected  – total: ${clients.size}`);
}

/**
 * Remove an SSE client (called when the connection closes).
 * @param {import('http').ServerResponse} res
 */
export function removeClient(res) {
  clients.delete(res);
  console.log(`[sse] client disconnected – total: ${clients.size}`);
}

/**
 * Broadcast a named SSE event carrying a JSON payload to every connected client.
 * @param {string} event  – SSE event name
 * @param {unknown} data  – will be JSON-serialised as the event data
 */
export function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) {
    try {
      res.write(payload);
    } catch (err) {
      // If writing fails the client is gone; clean up silently.
      console.warn('[sse] failed to write to client, removing:', err.message);
      clients.delete(res);
    }
  }
}
