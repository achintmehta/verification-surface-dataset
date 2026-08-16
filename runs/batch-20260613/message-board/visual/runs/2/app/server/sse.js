/**
 * SSE connection registry.
 * Keeps track of all active EventSource clients and provides
 * a broadcast helper to push events to every connected client.
 */

/** @type {Set<import('express').Response>} */
const clients = new Set();

/**
 * Register a new SSE client response object.
 * Sends the required HTTP headers and an initial "connected" comment.
 *
 * @param {import('express').Request}  req
 * @param {import('express').Response} res
 */
export function addClient(req, res) {
  res.set({
    'Content-Type':  'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection':    'keep-alive',
    'X-Accel-Buffering': 'no',   // disable Nginx buffering if behind a proxy
  });
  res.flushHeaders();

  // Keep the connection alive with a comment every 25 s
  const heartbeat = setInterval(() => {
    res.write(': heartbeat\n\n');
  }, 25_000);

  clients.add(res);
  console.log(`[sse] client connected  (total: ${clients.size})`);

  // Clean up when the client disconnects
  req.on('close', () => {
    clearInterval(heartbeat);
    clients.delete(res);
    console.log(`[sse] client disconnected (total: ${clients.size})`);
  });
}

/**
 * Broadcast a named SSE event with a JSON payload to every connected client.
 *
 * @param {string} event  - SSE event name
 * @param {object} data   - payload (will be JSON-serialised)
 */
export function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of clients) {
    client.write(payload);
  }
  console.log(`[sse] broadcast "${event}" → ${clients.size} client(s)`);
}
