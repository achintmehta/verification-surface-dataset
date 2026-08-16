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

  // Send an initial "connected" comment to flush the connection
  res.write(': connected\n\n');

  clients.add(res);
  console.log(`[sse] Client connected. Total: ${clients.size}`);

  // Remove client on disconnect
  req.on('close', () => {
    clients.delete(res);
    console.log(`[sse] Client disconnected. Total: ${clients.size}`);
  });
}

/**
 * Broadcast a named event with a JSON payload to all connected clients.
 *
 * @param {string} event  - SSE event name (e.g. 'card-created', 'card-moved', 'column-reordered')
 * @param {object} data   - Payload; will be JSON-serialised
 */
export function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  let dead = [];
  for (const client of clients) {
    try {
      client.write(payload);
    } catch {
      dead.push(client);
    }
  }
  // Clean up any broken connections discovered during broadcast
  for (const c of dead) clients.delete(c);
  console.log(`[sse] Broadcast "${event}" to ${clients.size} client(s).`);
}
