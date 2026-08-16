/**
 * SSE connection registry.
 * Keeps track of all active EventSource clients and provides
 * a broadcast helper to push events to every connected client.
 */

/** @type {Set<import('express').Response>} */
const clients = new Set();

/**
 * Register a new SSE client response object.
 * Sends the required SSE headers and sets up cleanup on close.
 *
 * @param {import('express').Request}  req
 * @param {import('express').Response} res
 */
export function addClient(req, res) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // disable nginx buffering if present
  res.flushHeaders();

  // Send a comment to keep the connection alive immediately
  res.write(': connected\n\n');

  clients.add(res);
  console.log(`[sse] client connected  — total: ${clients.size}`);

  req.on('close', () => {
    clients.delete(res);
    console.log(`[sse] client disconnected — total: ${clients.size}`);
  });
}

/**
 * Broadcast a named SSE event with a JSON payload to all connected clients.
 *
 * @param {string} event  - SSE event name
 * @param {object} data   - payload (will be JSON-serialised)
 */
export function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) {
    res.write(payload);
  }
  console.log(`[sse] broadcast "${event}" to ${clients.size} client(s)`);
}
