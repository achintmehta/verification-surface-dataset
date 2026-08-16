// Minimal Server-Sent Events hub. Tracks connected clients and pushes seat
// status transitions to all of them.

let clients = [];
let nextId = 1;

export function addClient(res) {
  const id = nextId++;
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  // Initial comment to open the stream and a hello event.
  res.write(': connected\n\n');
  res.write(`event: hello\ndata: ${JSON.stringify({ clientId: id })}\n\n`);

  const client = { id, res };
  clients.push(client);
  return client;
}

export function removeClient(id) {
  clients = clients.filter((c) => c.id !== id);
}

export function clientCount() {
  return clients.length;
}

/**
 * Broadcast a seat-status change event. `seats` is an array of changed seats in
 * their public shape.
 */
export function broadcastSeats(seats) {
  if (!seats || seats.length === 0) return;
  const payload = JSON.stringify({ seats, at: new Date().toISOString() });
  const frame = `event: seats\ndata: ${payload}\n\n`;
  for (const c of clients) {
    try {
      c.res.write(frame);
    } catch {
      // Drop broken connections silently; they'll be cleaned on close.
    }
  }
}

// Periodic heartbeat to keep proxies/browsers from closing idle connections.
export function startHeartbeat(intervalMs = 25_000) {
  return setInterval(() => {
    for (const c of clients) {
      try {
        c.res.write(': ping\n\n');
      } catch {
        // ignore
      }
    }
  }, intervalMs);
}
