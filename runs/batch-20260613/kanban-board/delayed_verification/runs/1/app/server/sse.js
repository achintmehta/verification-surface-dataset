/**
 * SSE connection registry and broadcast helpers.
 *
 * Each connected client gets a Response stream kept alive with periodic
 * heartbeat comments so proxies don't time out the connection.
 */

const clients = new Set();

/**
 * Register an Express res object as an SSE client.
 * Returns a cleanup function that removes the client.
 */
export function addClient(req, res) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // disable nginx buffering
  res.flushHeaders();

  // Send an initial comment so the browser knows the stream is open
  res.write(': connected\n\n');

  const heartbeat = setInterval(() => {
    res.write(': heartbeat\n\n');
  }, 20_000);

  clients.add(res);

  const cleanup = () => {
    clearInterval(heartbeat);
    clients.delete(res);
  };

  req.on('close', cleanup);
  req.on('error', cleanup);

  return cleanup;
}

/**
 * Broadcast a named SSE event with a JSON payload to every connected client.
 */
export function broadcast(eventName, payload) {
  const data = JSON.stringify(payload);
  const message = `event: ${eventName}\ndata: ${data}\n\n`;

  for (const res of clients) {
    try {
      res.write(message);
    } catch {
      clients.delete(res);
    }
  }
}

export function clientCount() {
  return clients.size;
}
