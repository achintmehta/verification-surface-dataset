/**
 * A tiny in-memory registry of active Server-Sent Events connections.
 *
 * Since PGLite is tied to a single Node.js instance (no horizontal scaling),
 * keeping the set of clients in memory is sufficient to broadcast new messages
 * to every connected browser tab.
 */

/** @type {Set<import('express').Response>} */
const clients = new Set();

/**
 * Register a new SSE client and configure the response for streaming.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
export function addClient(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    // Disable proxy buffering so events are flushed immediately.
    'X-Accel-Buffering': 'no',
  });

  // Send an initial comment to establish the stream and prompt the client to
  // open the connection right away.
  res.write(': connected\n\n');

  clients.add(res);

  // Periodic heartbeat keeps intermediaries from closing an idle connection.
  const heartbeat = setInterval(() => {
    res.write(': ping\n\n');
  }, 25000);

  req.on('close', () => {
    clearInterval(heartbeat);
    clients.delete(res);
  });
}

/**
 * Broadcast a named event with a JSON payload to every connected client.
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

/**
 * @returns {number} The number of currently connected SSE clients.
 */
export function clientCount() {
  return clients.size;
}
