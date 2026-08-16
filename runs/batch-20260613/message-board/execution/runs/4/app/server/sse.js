/**
 * SSE connection manager.
 *
 * Keeps track of every active SSE response object and provides
 * a broadcast helper that fans a message out to all of them.
 */

/** @type {Set<import('express').Response>} */
const clients = new Set();

/**
 * Register a new SSE client.
 * Sets the required headers and sends an initial "connected" comment
 * so the browser EventSource knows the stream is alive.
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

  // Send a heartbeat comment immediately so the client knows it's connected
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
 * Broadcast a named SSE event with a JSON payload to every connected client.
 *
 * @param {string} event  - The SSE event name (maps to EventSource `type`)
 * @param {object} data   - Payload; will be JSON-serialised
 */
export function broadcast(event, data) {
  const chunk = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) {
    res.write(chunk);
  }
}
