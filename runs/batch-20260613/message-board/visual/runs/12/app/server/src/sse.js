/**
 * Tiny registry of active Server-Sent Events connections.
 *
 * Each connected client holds one HTTP response we keep open. When a new
 * message is posted we write it to every open connection so all browsers
 * update in real time.
 */

const clients = new Set();

/**
 * Register a new SSE client. Sets the required SSE headers, sends an initial
 * comment to open the stream, and starts a keep-alive heartbeat.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
export function addClient(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  // Flush headers and tell the client to retry after 3s if disconnected.
  res.write('retry: 3000\n\n');
  res.write(': connected\n\n');

  const client = { res };
  clients.add(client);

  // Heartbeat keeps proxies from closing the idle connection.
  const heartbeat = setInterval(() => {
    res.write(': ping\n\n');
  }, 25000);

  req.on('close', () => {
    clearInterval(heartbeat);
    clients.delete(client);
  });
}

/**
 * Broadcast a named event with a JSON payload to all connected clients.
 *
 * @param {string} event
 * @param {unknown} data
 */
export function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of clients) {
    client.res.write(payload);
  }
}

export function clientCount() {
  return clients.size;
}
