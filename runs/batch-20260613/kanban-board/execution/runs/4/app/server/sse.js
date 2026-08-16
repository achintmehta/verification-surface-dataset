/**
 * SSE connection manager.
 * Keeps a set of active response objects and provides a broadcast helper.
 */

const clients = new Set();

/**
 * Register a new SSE client.
 * @param {import('express').Request}  req
 * @param {import('express').Response} res
 */
export function addClient(req, res) {
  res.set({
    'Content-Type':  'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection':    'keep-alive',
    'X-Accel-Buffering': 'no',   // disable nginx buffering if present
  });
  res.flushHeaders();

  // Send a heartbeat comment every 25 s to keep the connection alive
  const heartbeat = setInterval(() => {
    res.write(': heartbeat\n\n');
  }, 25_000);

  clients.add(res);
  console.log(`[sse] client connected  (total: ${clients.size})`);

  req.on('close', () => {
    clearInterval(heartbeat);
    clients.delete(res);
    console.log(`[sse] client disconnected (total: ${clients.size})`);
  });
}

/**
 * Broadcast a named event with a JSON payload to all connected clients.
 * @param {string} event  - SSE event name
 * @param {object} data   - will be JSON-serialised
 */
export function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) {
    res.write(payload);
  }
  console.log(`[sse] broadcast "${event}" to ${clients.size} client(s)`);
}
