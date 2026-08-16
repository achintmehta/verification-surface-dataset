/**
 * sse.js – Server-Sent Events broadcast hub.
 *
 * All connected clients receive every seat-status transition so their seat
 * maps stay live without polling.
 *
 * Event shape (JSON):
 *   { type: 'seat_update', seats: [ { id, status, holdId?, expiresAt? }, … ] }
 *   { type: 'ping' }          – keepalive every 15 s
 */

const clients = new Set();

/**
 * Attach a new SSE client.  Returns a cleanup function.
 */
export function addClient(req, res) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // disable nginx buffering if present
  res.flushHeaders();

  // Send an immediate connection-established event.
  res.write(`event: connected\ndata: {}\n\n`);

  clients.add(res);

  const cleanup = () => {
    clients.delete(res);
  };

  req.on('close', cleanup);
  req.on('error', cleanup);

  return cleanup;
}

/**
 * Broadcast a seat_update event to every connected client.
 *
 * @param {Array<{id:string, status:string, holdId?:string|null, expiresAt?:string|null, bookedBy?:string|null}>} seats
 */
export function broadcastSeatUpdate(seats) {
  if (seats.length === 0) return;
  const payload = JSON.stringify({ type: 'seat_update', seats });
  const msg = `event: seat_update\ndata: ${payload}\n\n`;
  for (const res of clients) {
    try {
      res.write(msg);
    } catch {
      clients.delete(res);
    }
  }
}

/**
 * Keepalive ping – prevents proxies from closing idle connections.
 */
export function startKeepalive(intervalMs = 15_000) {
  setInterval(() => {
    const msg = `event: ping\ndata: {}\n\n`;
    for (const res of clients) {
      try {
        res.write(msg);
      } catch {
        clients.delete(res);
      }
    }
  }, intervalMs);
}

export function clientCount() {
  return clients.size;
}
