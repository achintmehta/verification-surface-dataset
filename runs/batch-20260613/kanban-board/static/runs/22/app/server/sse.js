/**
 * SSE connection manager.
 * Maintains a set of active Response objects and broadcasts events to all.
 */

/** @type {Set<import('express').Response>} */
const clients = new Set();

/**
 * Register a new SSE client connection.
 * @param {import('express').Request} _req
 * @param {import('express').Response} res
 */
export function addClient(_req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no', // disable nginx buffering if present
  });

  // Send an initial comment to flush headers
  res.write(':connected\n\n');

  clients.add(res);

  // Remove client when connection is closed
  _req.on('close', () => {
    clients.delete(res);
  });
}

/**
 * Broadcast an SSE event to all connected clients.
 * @param {string} event - event name
 * @param {unknown} data  - serialisable payload
 */
export function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of clients) {
    client.write(payload);
  }
}
