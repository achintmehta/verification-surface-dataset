// A minimal Server-Sent Events hub. It tracks active client connections and
// broadcasts JSON events to all of them.

let nextClientId = 1;
const clients = new Map(); // id -> res

/**
 * Registers an SSE connection. Returns a function that removes it.
 */
export function addClient(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    // Disable proxy buffering (nginx) so events flush immediately.
    'X-Accel-Buffering': 'no',
  });

  const id = nextClientId++;
  clients.set(id, res);

  // Send an initial comment so the connection is established and a hello event
  // so clients know they're connected.
  res.write(`retry: 2000\n`);
  res.write(`event: hello\ndata: ${JSON.stringify({ clientId: id })}\n\n`);

  // Heartbeat keeps proxies/load balancers from closing idle connections.
  const heartbeat = setInterval(() => {
    res.write(`: ping\n\n`);
  }, 25000);

  const cleanup = () => {
    clearInterval(heartbeat);
    clients.delete(id);
  };

  req.on('close', cleanup);
  res.on('error', cleanup);

  return cleanup;
}

/**
 * Broadcasts an event to every connected client.
 * @param {string} type event name
 * @param {object} payload serializable data
 */
export function broadcast(type, payload) {
  const data = JSON.stringify(payload);
  for (const res of clients.values()) {
    try {
      res.write(`event: ${type}\ndata: ${data}\n\n`);
    } catch {
      // The connection's own close/error handler will clean it up.
    }
  }
}

export function clientCount() {
  return clients.size;
}
