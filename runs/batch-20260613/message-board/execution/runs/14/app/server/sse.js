/**
 * Minimal Server-Sent Events (SSE) connection manager.
 *
 * Keeps a registry of active client responses and exposes helpers to add a
 * new client, remove a client, and broadcast events to every connected client.
 */

const clients = new Set();

/**
 * Register a new SSE client. Sets up the appropriate headers and a heartbeat
 * to keep the connection alive through proxies. Returns a cleanup function.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
export function addClient(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    // Allow cross-origin EventSource connections (matches the cors() config).
    'Access-Control-Allow-Origin': '*',
    'X-Accel-Buffering': 'no',
  });

  // Flush headers immediately so the browser marks the connection as open.
  res.write('retry: 3000\n\n');
  if (typeof res.flushHeaders === 'function') res.flushHeaders();

  const client = { res };
  clients.add(client);

  // Heartbeat comment every 25s keeps the stream from being closed by idle timeouts.
  const heartbeat = setInterval(() => {
    res.write(': heartbeat\n\n');
  }, 25000);

  const cleanup = () => {
    clearInterval(heartbeat);
    clients.delete(client);
  };

  req.on('close', cleanup);
  req.on('error', cleanup);

  return cleanup;
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
    try {
      client.res.write(payload);
    } catch {
      clients.delete(client);
    }
  }
}

export function clientCount() {
  return clients.size;
}
