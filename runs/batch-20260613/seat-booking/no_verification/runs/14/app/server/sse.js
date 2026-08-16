// Simple Server-Sent Events hub. Tracks connected clients and broadcasts
// seat-status transitions to all of them.

const clients = new Set();

/**
 * Register a new SSE client. Express req/res are passed in.
 */
export function addClient(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  // Initial comment to open the stream.
  res.write(': connected\n\n');

  const client = { res };
  clients.add(client);

  // Heartbeat to keep the connection alive through proxies.
  const heartbeat = setInterval(() => {
    res.write(': ping\n\n');
  }, 25_000);

  req.on('close', () => {
    clearInterval(heartbeat);
    clients.delete(client);
  });
}

/**
 * Broadcast an event to every connected client.
 * @param {string} type - event name
 * @param {object} data - JSON-serializable payload
 */
export function broadcast(type, data) {
  const payload = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of clients) {
    try {
      client.res.write(payload);
    } catch {
      clients.delete(client);
    }
  }
}

/**
 * Broadcast a list of seat changes. Each entry is the effective seat object.
 */
export function broadcastSeatChanges(seats) {
  if (!seats || seats.length === 0) return;
  broadcast('seats', { seats });
}
