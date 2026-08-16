/**
 * A tiny Server-Sent Events broker.
 *
 * Keeps track of every connected client's response stream and lets us
 * broadcast events to all of them at once.
 */
const clients = new Set();

/**
 * Register a new SSE client. Sets the appropriate headers, sends an initial
 * comment to open the stream, and wires up a keep-alive ping.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
export function addClient(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    // Disable proxy buffering (e.g. nginx) so events flush immediately.
    'X-Accel-Buffering': 'no',
  });

  // Flush headers / open the stream immediately.
  res.write(': connected\n\n');

  // Periodic comment to keep the connection alive through proxies/timeouts.
  const keepAlive = setInterval(() => {
    res.write(': ping\n\n');
  }, 25000);

  const client = { res };
  clients.add(client);

  const cleanup = () => {
    clearInterval(keepAlive);
    clients.delete(client);
  };

  req.on('close', cleanup);
  res.on('error', cleanup);

  return client;
}

/**
 * Broadcast a named event with a JSON payload to every connected client.
 *
 * @param {string} event
 * @param {unknown} data
 */
export function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of clients) {
    try {
      client.res.write(payload);
    } catch {
      clients.delete(client);
    }
  }
}

/**
 * Number of currently connected SSE clients (useful for diagnostics).
 */
export function clientCount() {
  return clients.size;
}
