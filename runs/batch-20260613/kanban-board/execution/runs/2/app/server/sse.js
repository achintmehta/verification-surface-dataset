/**
 * SSE (Server-Sent Events) connection manager.
 *
 * Clients connect to GET /api/stream and receive a stream of JSON events.
 * Every mutation broadcasts to all active connections.
 */

const clients = new Set();

/**
 * Register a new SSE client response object.
 * Sends the required headers and an initial "connected" event.
 */
export function addClient(req, res) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // disable nginx buffering if present
  res.flushHeaders();

  // Send a heartbeat comment immediately so the browser knows the stream is live
  res.write(': connected\n\n');

  clients.add(res);
  console.log(`[sse] client connected (total: ${clients.size})`);

  // Heartbeat every 25 s to keep the connection alive through proxies
  const heartbeat = setInterval(() => {
    if (!res.writableEnded) {
      res.write(': heartbeat\n\n');
    }
  }, 25_000);

  req.on('close', () => {
    clearInterval(heartbeat);
    clients.delete(res);
    console.log(`[sse] client disconnected (total: ${clients.size})`);
  });
}

/**
 * Broadcast an event to all connected clients.
 *
 * @param {string} eventName  - SSE event name (e.g. "card-created", "card-moved", "column-renormalized")
 * @param {object} data       - Payload; will be JSON-serialized
 */
export function broadcast(eventName, data) {
  const payload = `event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`;
  let dead = [];
  for (const res of clients) {
    if (res.writableEnded) {
      dead.push(res);
    } else {
      res.write(payload);
    }
  }
  // Clean up any stale connections
  for (const res of dead) clients.delete(res);
  console.log(`[sse] broadcast "${eventName}" to ${clients.size} client(s)`);
}
