/**
 * SSE (Server-Sent Events) module.
 * Manages active client connections and broadcasts events.
 */

/** @type {Set<import('express').Response>} */
const clients = new Set();

/**
 * Express handler for GET /api/stream.
 * Keeps the connection open and registers the client for broadcasts.
 */
export function sseHandler(req, res) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // disable nginx buffering if present
  res.flushHeaders();

  // Send an initial heartbeat so the client knows the connection is live
  res.write('event: connected\ndata: {}\n\n');

  clients.add(res);

  // Heartbeat every 25 s to keep the connection alive through proxies
  const heartbeat = setInterval(() => {
    res.write(': heartbeat\n\n');
  }, 25_000);

  req.on('close', () => {
    clearInterval(heartbeat);
    clients.delete(res);
  });
}

/**
 * Broadcast a named SSE event with a JSON payload to all connected clients.
 * @param {string} event - event name
 * @param {unknown} data  - JSON-serialisable payload
 */
export function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of clients) {
    try {
      client.write(payload);
    } catch {
      // Client disconnected between the check and the write – remove it
      clients.delete(client);
    }
  }
}

/** Returns the number of currently connected SSE clients (useful for tests/debug). */
export function clientCount() {
  return clients.size;
}
