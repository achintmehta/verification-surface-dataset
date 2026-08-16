/**
 * Lightweight Server-Sent Events connection registry.
 *
 * We keep a set of active HTTP responses. Each connected client holds one
 * long-lived response, and we write SSE-formatted events to all of them when a
 * new message is broadcast.
 */

/** @type {Set<import('express').Response>} */
const clients = new Set();

/**
 * Registers a new SSE client connection and configures the response headers.
 * Returns a cleanup function to be called when the connection closes.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @returns {() => void} cleanup
 */
export function addClient(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    // Disable proxy buffering (e.g. nginx) so events are flushed immediately.
    'X-Accel-Buffering': 'no',
  });

  // Send an initial comment to establish the stream and flush headers.
  res.write(': connected\n\n');

  clients.add(res);

  // Periodic heartbeat keeps the connection alive through idle timeouts.
  const heartbeat = setInterval(() => {
    res.write(': ping\n\n');
  }, 25000);

  const cleanup = () => {
    clearInterval(heartbeat);
    clients.delete(res);
  };

  req.on('close', cleanup);
  return cleanup;
}

/**
 * Broadcasts a named event with a JSON payload to every connected client.
 *
 * @param {string} event
 * @param {unknown} data
 */
export function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) {
    res.write(payload);
  }
}

/** @returns {number} number of currently connected SSE clients */
export function clientCount() {
  return clients.size;
}
