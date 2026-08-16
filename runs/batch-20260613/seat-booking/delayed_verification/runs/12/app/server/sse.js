// Simple SSE connection registry. Each connected client gets an entry; we write
// `data:` lines to every client on each seat-status transition.

let clients = new Set();
let nextId = 1;

export function addClient(res) {
  const id = nextId++;
  const client = { id, res };
  clients.add(client);

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  // Initial comment to open the stream and a hello event.
  res.write(`retry: 3000\n`);
  res.write(`event: hello\ndata: ${JSON.stringify({ clientId: id })}\n\n`);

  return client;
}

export function removeClient(client) {
  clients.delete(client);
}

/**
 * Broadcast a seat-status transition message to all connected clients.
 * `message` is an object like { type, seatIds, ... }.
 */
export function broadcast(message) {
  const payload = JSON.stringify({ ...message, ts: Date.now() });
  const data = `event: seats\ndata: ${payload}\n\n`;
  for (const client of clients) {
    try {
      client.res.write(data);
    } catch {
      clients.delete(client);
    }
  }
}

// Keep-alive ping so proxies/browsers don't close idle connections.
export function startHeartbeat(intervalMs = 25_000) {
  const timer = setInterval(() => {
    for (const client of clients) {
      try {
        client.res.write(`: ping\n\n`);
      } catch {
        clients.delete(client);
      }
    }
  }, intervalMs);
  timer.unref?.();
  return timer;
}

export function clientCount() {
  return clients.size;
}
