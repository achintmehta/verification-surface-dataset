/**
 * SSE (Server-Sent Events) module.
 *
 * Maintains the set of active SSE connections and provides a broadcast
 * helper used by mutation handlers to push canonical state to all clients.
 */

/** @type {Set<import('express').Response>} */
const clients = new Set();

/**
 * Express route handler for GET /api/stream.
 * Keeps the connection alive and registers the client for broadcasts.
 */
export function sseHandler(req, res) {
  // SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // disable nginx buffering if present
  res.flushHeaders();

  // Send an initial "connected" comment so the client knows the stream is live
  res.write(': connected\n\n');

  clients.add(res);
  console.log(`[sse] client connected  (total: ${clients.size})`);

  // Remove client on disconnect
  req.on('close', () => {
    clients.delete(res);
    console.log(`[sse] client disconnected (total: ${clients.size})`);
  });
}

/**
 * Broadcast a named event with a JSON payload to every connected client.
 *
 * @param {string} event  - SSE event name (e.g. 'card:created', 'card:moved', 'column:reordered')
 * @param {unknown} data  - Payload; will be JSON-serialised
 */
export function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of clients) {
    try {
      client.write(payload);
    } catch (err) {
      // If writing fails the client is gone; clean up
      clients.delete(client);
    }
  }
}
