/**
 * Minimal Server-Sent Events connection registry.
 *
 * Each connected client holds one HTTP response object that we keep open and
 * write to whenever a new message is broadcast.
 */

/** @type {Set<import('express').Response>} */
const clients = new Set();

/**
 * Register a new SSE client and set up the long-lived connection.
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
export function addClient(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    // Disable proxy buffering so events flush immediately.
    'X-Accel-Buffering': 'no',
  });

  // Tell the browser to retry after 3s if the connection drops.
  res.write('retry: 3000\n\n');
  // Initial comment to open the stream.
  res.write(': connected\n\n');

  clients.add(res);

  // Heartbeat keeps intermediaries from closing idle connections.
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
 * @param {string} event
 * @param {unknown} data
 */
export function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) {
    res.write(payload);
  }
}

/** @returns {number} number of currently connected clients */
export function clientCount() {
  return clients.size;
}
