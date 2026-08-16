// Minimal Server-Sent Events hub. Tracks every connected client response
// stream and pushes named events to all of them.

const clients = new Set();
let nextClientId = 1;

/**
 * Registers a new SSE client. Returns a cleanup function to call on disconnect.
 */
export function addClient(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    // Disable proxy buffering (e.g. nginx) so events flush immediately.
    'X-Accel-Buffering': 'no',
  });
  // Flush headers immediately.
  res.flushHeaders?.();

  const client = { id: nextClientId++, res };
  clients.add(client);

  // Initial comment + retry hint so EventSource reconnects quickly.
  res.write(`retry: 2000\n`);
  res.write(`: connected ${client.id}\n\n`);

  // Heartbeat keeps intermediaries from closing idle connections.
  const heartbeat = setInterval(() => {
    res.write(`: ping\n\n`);
  }, 25000);

  const cleanup = () => {
    clearInterval(heartbeat);
    clients.delete(client);
  };

  req.on('close', cleanup);
  return cleanup;
}

/**
 * Broadcasts a named event with a JSON payload to every connected client.
 */
export function broadcast(event, payload) {
  const data = JSON.stringify(payload);
  for (const client of clients) {
    try {
      client.res.write(`event: ${event}\n`);
      client.res.write(`data: ${data}\n\n`);
    } catch {
      // Drop broken connections silently; their close handler will clean up.
      clients.delete(client);
    }
  }
}

export function clientCount() {
  return clients.size;
}
