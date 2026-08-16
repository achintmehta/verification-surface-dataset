/**
 * Server-Sent Events (SSE) broadcaster.
 *
 * Maintains a set of active response objects and provides a `broadcast`
 * function that pushes a named event + JSON payload to every connected client.
 */

/** @type {Set<import('express').Response>} */
const clients = new Set();

/**
 * Express route handler for GET /api/stream.
 * Keeps the connection open and registers the client for broadcasts.
 *
 * @param {import('express').Request}  req
 * @param {import('express').Response} res
 */
export function sseHandler(req, res) {
  // SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // disable nginx buffering if present
  res.flushHeaders();

  // Send an initial "connected" event so the client knows the stream is live
  res.write(`event: connected\ndata: ${JSON.stringify({ ok: true })}\n\n`);

  clients.add(res);
  console.log(`[sse] Client connected. Total: ${clients.size}`);

  // Clean up when the client disconnects
  req.on('close', () => {
    clients.delete(res);
    console.log(`[sse] Client disconnected. Total: ${clients.size}`);
  });
}

/**
 * Broadcast a named event to every connected SSE client.
 *
 * @param {string} eventName  – e.g. 'seat-update'
 * @param {unknown} data      – will be JSON-serialised
 */
export function broadcast(eventName, data) {
  const payload = `event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of clients) {
    try {
      client.write(payload);
    } catch {
      // If writing fails the client is gone; remove it
      clients.delete(client);
    }
  }
}

/** Return the number of currently connected SSE clients (useful for tests/debug). */
export function clientCount() {
  return clients.size;
}
