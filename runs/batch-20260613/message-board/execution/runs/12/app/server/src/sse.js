/**
 * Tiny in-memory registry of active SSE client connections.
 * Each client is an Express `res` object that we keep open.
 */
const clients = new Set();

/**
 * Registers a new SSE client connection.
 * Sets the required headers and keeps the connection open.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
export function addClient(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    // Helps disable proxy buffering (e.g. nginx) so events flush immediately.
    'X-Accel-Buffering': 'no',
  });

  // Flush headers and send an initial comment so the connection is established.
  res.write(': connected\n\n');

  clients.add(res);

  // Keep the connection alive through idle proxies with periodic heartbeats.
  const heartbeat = setInterval(() => {
    res.write(': ping\n\n');
  }, 25000);

  req.on('close', () => {
    clearInterval(heartbeat);
    clients.delete(res);
  });
}

/**
 * Broadcasts a named event with a JSON payload to every connected client.
 *
 * @param {string} event
 * @param {unknown} payload
 */
export function broadcast(event, payload) {
  const data = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const res of clients) {
    res.write(data);
  }
}

export function clientCount() {
  return clients.size;
}
