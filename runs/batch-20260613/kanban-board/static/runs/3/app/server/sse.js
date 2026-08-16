/**
 * SSE connection manager.
 * Keeps a registry of active Response objects and provides a broadcast helper.
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

  // Send a heartbeat comment immediately so the browser knows the stream is live
  res.write(': connected\n\n');

  clients.add(res);

  // Keep-alive ping every 25 s
  const heartbeat = setInterval(() => {
    res.write(': ping\n\n');
  }, 25_000);

  req.on('close', () => {
    clearInterval(heartbeat);
    clients.delete(res);
  });
}

/**
 * Broadcast a named event with a JSON payload to every connected client.
 * @param {string} event  - SSE event name
 * @param {unknown} data  - will be JSON-serialised
 */
export function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) {
    try {
      res.write(payload);
    } catch {
      clients.delete(res);
    }
  }
}
