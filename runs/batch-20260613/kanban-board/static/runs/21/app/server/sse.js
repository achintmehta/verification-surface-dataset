/**
 * SSE connection manager.
 * Maintains a set of active response objects and provides broadcast helpers.
 */

/** @type {Set<import('express').Response>} */
const clients = new Set();

/**
 * Register an SSE client.
 * @param {import('express').Request} _req
 * @param {import('express').Response} res
 */
export function addClient(_req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no', // disable nginx buffering if applicable
  });
  // Send an initial comment to flush headers / confirm connection
  res.write(':ok\n\n');

  clients.add(res);

  _req.on('close', () => {
    clients.delete(res);
  });
}

/**
 * Broadcast a named event with JSON data to every connected client.
 * @param {string} event
 * @param {unknown} data
 */
export function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) {
    res.write(payload);
  }
}
