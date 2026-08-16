// Minimal Server-Sent Events hub. Keeps a set of active client responses
// and broadcasts seat-status transitions to all of them.

const clients = new Set();

export function addClient(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    // Disable proxy buffering where applicable.
    'X-Accel-Buffering': 'no'
  });
  // Establish the stream and tell the client to retry quickly on disconnect.
  res.write('retry: 3000\n\n');

  const client = { res };
  clients.add(client);

  // Heartbeat to keep the connection alive through proxies.
  const heartbeat = setInterval(() => {
    try {
      res.write(': ping\n\n');
    } catch {
      cleanup();
    }
  }, 25_000);

  function cleanup() {
    clearInterval(heartbeat);
    clients.delete(client);
  }

  res.on('close', cleanup);
  return cleanup;
}

// Broadcast a seat-status change event. `seats` is an array of seat rows
// (effective view) that just transitioned.
export function broadcast(event, payload) {
  const data = JSON.stringify(payload);
  const message = `event: ${event}\ndata: ${data}\n\n`;
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
