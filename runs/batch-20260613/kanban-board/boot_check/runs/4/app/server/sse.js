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

  // Send a heartbeat comment every 25 s to keep the connection alive through
  // proxies that close idle connections.
  const heartbeat = setInterval(() => {
    res.write(': heartbeat\n\n');
  }, 25_000);

  clients.add(res);

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
    res.write(payload);
  }
}

export function clientCount() {
  return clients.size;
}
