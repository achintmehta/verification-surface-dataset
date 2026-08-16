/**
 * SSE connection manager.
 *
 * Keeps track of every active SSE response object and provides a
 * broadcast helper that pushes a JSON payload to all of them.
 */

/** @type {Set<import('express').Response>} */
const clients = new Set();

/**
 * Register a new SSE client.
 * Sets the required headers and sends an initial "connected" comment so the
 * browser's EventSource knows the stream is alive.
 *
 * @param {import('express').Request}  req
 * @param {import('express').Response} res
 */
export function addClient(req, res) {
  res.set({
    'Content-Type':  'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection':    'keep-alive',
    // Allow the browser to reconnect automatically
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();

  // Send a comment to confirm the connection is open
  res.write(': connected\n\n');

  clients.add(res);
  console.log(`[sse] client connected  – total: ${clients.size}`);

  // Clean up when the client disconnects
  req.on('close', () => {
    clients.delete(res);
    console.log(`[sse] client disconnected – total: ${clients.size}`);
  });
}

/**
 * Broadcast a message to every connected SSE client.
 *
 * @param {string} event  - The SSE event name (e.g. "message")
 * @param {object} data   - A JSON-serialisable payload
 */
export function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

  for (const client of clients) {
    client.write(payload);
  }

  console.log(`[sse] broadcast "${event}" to ${clients.size} client(s)`);
}
