// Server-Sent Events hub: keeps track of connected clients and broadcasts
// seat status transitions so every seat map stays live.

const clients = new Set();
let nextClientId = 1;

/**
 * Register a new SSE client. Writes the required SSE headers and a comment
 * keep-alive line, then keeps the connection open. Returns a cleanup fn.
 */
export function addClient(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  // Flush headers immediately.
  res.write('retry: 3000\n\n');

  const client = { id: nextClientId++, res };
  clients.add(client);

  // Periodic comment to keep the connection alive through proxies.
  const keepAlive = setInterval(() => {
    res.write(': keep-alive\n\n');
  }, 25_000);

  const cleanup = () => {
    clearInterval(keepAlive);
    clients.delete(client);
  };

  req.on('close', cleanup);
  return cleanup;
}

/**
 * Broadcast an event to all connected SSE clients.
 * @param {string} event - event name
 * @param {object} data - JSON-serializable payload
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
 * Broadcast a set of seat status changes. `seats` is an array of seat rows
 * (id, status, ...). Clients merge these into their local seat map.
 */
export function broadcastSeatUpdates(seats) {
  if (!seats || seats.length === 0) return;
  broadcast('seats', { seats });
}

export function clientCount() {
  return clients.size;
}
