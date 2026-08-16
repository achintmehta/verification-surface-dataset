/**
 * SSE connection manager.
 *
 * Keeps track of every active EventSource connection and provides a
 * broadcast helper that pushes a named event + JSON payload to all of them.
 */

/** @type {Set<import('express').Response>} */
const clients = new Set();

/**
 * Register an Express response object as an SSE client.
 * Sends the required headers and an initial "connected" comment so the
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
    // Disable response buffering in proxies / nginx
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();

  // Send an initial comment so the client knows the connection is live
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
 * Broadcast a named SSE event carrying a JSON-serialised payload to every
 * currently connected client.
 *
 * @param {string} event   - The SSE event name (maps to EventSource `type`)
 * @param {object} payload - Data to serialise as JSON
 */
export function broadcast(event, payload) {
  const data = JSON.stringify(payload);
  const chunk = `event: ${event}\ndata: ${data}\n\n`;

  for (const res of clients) {
    res.write(chunk);
  }
}
