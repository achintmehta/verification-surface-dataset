/**
 * SSE (Server-Sent Events) manager.
 *
 * Maintains the set of active client connections and provides
 * a broadcast helper used by mutation handlers.
 */

const clients = new Set();

/**
 * Register a new SSE client response object.
 * Sends the required headers and an initial "connected" event.
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

  // Send a heartbeat comment immediately so the browser knows the stream is live
  res.write(': connected\n\n');

  clients.add(res);

  // Keep-alive heartbeat every 25 s to prevent proxy timeouts
  const heartbeat = setInterval(() => {
    res.write(': heartbeat\n\n');
  }, 25_000);

  req.on('close', () => {
    clearInterval(heartbeat);
    clients.delete(res);
  });
}

/**
 * Broadcast a named event with a JSON payload to every connected client.
 *
 * @param {string} event  - SSE event name
 * @param {object} data   - payload (will be JSON-serialised)
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
