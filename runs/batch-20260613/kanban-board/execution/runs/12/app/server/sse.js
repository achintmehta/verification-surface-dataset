// Minimal Server-Sent Events hub. Tracks active client connections and
// broadcasts JSON events to all of them.

const clients = new Set();

/**
 * Register a new SSE connection. Returns a cleanup function.
 */
export function addClient(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    // Disable proxy buffering (e.g. nginx) so events flush immediately.
    'X-Accel-Buffering': 'no',
  });
  // Establish the stream and tell the browser to retry quickly on disconnect.
  res.write('retry: 2000\n\n');

  const client = { res };
  clients.add(client);

  // Periodic comment line keeps idle connections alive through proxies.
  const keepAlive = setInterval(() => {
    try {
      res.write(': keep-alive\n\n');
    } catch {
      /* ignore */
    }
  }, 25000);

  const cleanup = () => {
    clearInterval(keepAlive);
    clients.delete(client);
  };

  return cleanup;
}

/**
 * Broadcast an event of the given type with a JSON-serializable payload to
 * every connected client.
 */
export function broadcast(type, payload) {
  const data = JSON.stringify({ type, payload });
  for (const client of clients) {
    try {
      client.res.write(`event: ${type}\n`);
      client.res.write(`data: ${data}\n\n`);
    } catch {
      // Broken pipe: drop the client.
      clients.delete(client);
    }
  }
}

export function clientCount() {
  return clients.size;
}
