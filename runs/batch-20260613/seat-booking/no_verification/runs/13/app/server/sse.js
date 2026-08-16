// Server-Sent Events hub: maintains active client connections and broadcasts
// seat-status transitions so every connected seat map stays live.

const clients = new Set();
let nextId = 1;

/**
 * Register an SSE connection. Sets the appropriate headers, sends an initial
 * comment to open the stream, and keeps the connection alive with heartbeats.
 * Returns a cleanup function (call on request close).
 */
export function addClient(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  // Flush headers immediately.
  res.write(': connected\n\n');

  const client = { id: nextId++, res };
  clients.add(client);

  // Heartbeat to keep proxies from closing idle connections.
  const heartbeat = setInterval(() => {
    try {
      res.write(': heartbeat\n\n');
    } catch {
      /* ignore */
    }
  }, 25_000);

  const cleanup = () => {
    clearInterval(heartbeat);
    clients.delete(client);
  };

  req.on('close', cleanup);
  return cleanup;
}

/**
 * Broadcast a seat-status change event to all connected clients.
 * `seats` is an array of seat objects (effective view).
 */
export function broadcast(type, payload) {
  const data = JSON.stringify({ type, ...payload });
  const frame = `event: ${type}\ndata: ${data}\n\n`;
  for (const client of clients) {
    try {
      client.res.write(frame);
    } catch {
      clients.delete(client);
    }
  }
}

export function clientCount() {
  return clients.size;
}
