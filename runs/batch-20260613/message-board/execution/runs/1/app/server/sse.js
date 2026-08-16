/**
 * SSE connection registry.
 *
 * Keeps track of every active SSE client and provides a broadcast helper
 * that pushes a named event + JSON payload to all of them.
 */

/** @type {Set<import('express').Response>} */
const clients = new Set();

/**
 * Register an Express response object as an SSE client.
 * Configures the correct headers and sends an initial "connected" comment
 * so the browser EventSource knows the stream is alive.
 *
 * @param {import('express').Request}  req
 * @param {import('express').Response} res
 */
export function addClient(req, res) {
  // SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // disable nginx buffering if present
  res.flushHeaders();

  // Send a comment line so the client knows the connection is established
  res.write(': connected\n\n');

  clients.add(res);
  console.log(`[sse] Client connected. Total: ${clients.size}`);

  // Clean up when the client disconnects
  req.on('close', () => {
    clients.delete(res);
    console.log(`[sse] Client disconnected. Total: ${clients.size}`);
  });
}

/**
 * Broadcast a named SSE event with a JSON-serialisable payload to every
 * currently connected client.
 *
 * @param {string} event  - The SSE event name (maps to EventSource `type`)
 * @param {unknown} data  - Will be JSON-stringified and sent as the `data` field
 */
export function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) {
    res.write(payload);
  }
}
