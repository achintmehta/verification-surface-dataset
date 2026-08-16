// Manages active Server-Sent Events connections and broadcasts seat-status
// transitions to every connected client so all seat maps stay live.

const clients = new Set();

/**
 * Register a new SSE client (Express response object). Sets up the headers and
 * a keep-alive ping, and returns a cleanup function to call on disconnect.
 */
export function addClient(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  // Initial comment to establish the stream.
  res.write(': connected\n\n');

  const client = { res };
  clients.add(client);

  // Keep-alive ping so proxies don't drop idle connections.
  const ping = setInterval(() => {
    try {
      res.write(': ping\n\n');
    } catch {
      /* ignore */
    }
  }, 25_000);

  const cleanup = () => {
    clearInterval(ping);
    clients.delete(client);
  };

  req.on('close', cleanup);
  return cleanup;
}

/**
 * Broadcast a seat-status update event to all connected clients.
 * @param {Array<{id:number,status:string}>} seats - changed seats with effective status
 * @param {string} reason - 'held' | 'booked' | 'released'
 */
export function broadcastSeatUpdate(seats, reason) {
  if (!seats || seats.length === 0) return;
  const payload = JSON.stringify({ type: 'seat-update', reason, seats });
  const message = `event: seat-update\ndata: ${payload}\n\n`;
  for (const client of clients) {
    try {
      client.res.write(message);
    } catch {
      clients.delete(client);
    }
  }
}

export function clientCount() {
  return clients.size;
}
