/**
 * SSE broadcast manager.
 * Keeps a set of active response objects and fans out events to all of them.
 */

const clients = new Set();

/**
 * Register a new SSE client.
 * @param {import('express').Request}  req
 * @param {import('express').Response} res
 */
export function addClient(req, res) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // disable nginx buffering if present
  res.flushHeaders();

  // Send a heartbeat comment immediately so the browser knows the stream is alive
  res.write(': connected\n\n');

  clients.add(res);
  console.log(`[sse] client connected  (total: ${clients.size})`);

  // Keep-alive ping every 20 s
  const ping = setInterval(() => {
    res.write(': ping\n\n');
  }, 20_000);

  req.on('close', () => {
    clearInterval(ping);
    clients.delete(res);
    console.log(`[sse] client disconnected (total: ${clients.size})`);
  });
}

/**
 * Broadcast a named event with a JSON payload to every connected client.
 * @param {string} event  - event name (e.g. 'card:created', 'card:moved', 'column:reordered')
 * @param {object} data   - payload (will be JSON-serialised)
 */
export function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) {
    res.write(payload);
  }
  console.log(`[sse] broadcast "${event}" to ${clients.size} client(s)`);
}
