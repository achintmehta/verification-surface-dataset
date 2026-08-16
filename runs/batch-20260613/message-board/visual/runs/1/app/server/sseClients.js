/**
 * In-memory registry of active SSE client response objects.
 * Each entry is a plain Node.js ServerResponse that has already
 * been configured with the correct SSE headers.
 */
const clients = new Set();

/**
 * Register a new SSE client.
 * @param {import('http').ServerResponse} res
 */
export function addClient(res) {
  clients.add(res);
  console.log(`[sse] client connected  — total: ${clients.size}`);
}

/**
 * Remove a disconnected SSE client.
 * @param {import('http').ServerResponse} res
 */
export function removeClient(res) {
  clients.delete(res);
  console.log(`[sse] client disconnected — total: ${clients.size}`);
}

/**
 * Broadcast a named SSE event with a JSON payload to every connected client.
 * @param {string} event  SSE event name
 * @param {unknown} data  Payload — will be JSON-serialised
 */
export function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) {
    res.write(payload);
  }
}
