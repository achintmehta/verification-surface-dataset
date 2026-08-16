/**
 * SSE (Server-Sent Events) broker.
 *
 * Maintains the set of active SSE connections and provides a broadcast
 * helper used by mutation handlers to push canonical state to every
 * connected client.
 */

/** @type {Set<import('express').Response>} */
const clients = new Set();

/**
 * Express middleware that upgrades the request to an SSE stream.
 * The connection is kept alive until the client disconnects.
 *
 * @param {import('express').Request}  req
 * @param {import('express').Response} res
 */
export function sseHandler(req, res) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // disable nginx buffering if present
  res.flushHeaders();

  // Send a comment every 25 s to keep the connection alive through proxies.
  const heartbeat = setInterval(() => {
    res.write(': heartbeat\n\n');
  }, 25_000);

  clients.add(res);
  console.log(`[sse] Client connected  (total: ${clients.size})`);

  req.on('close', () => {
    clearInterval(heartbeat);
    clients.delete(res);
    console.log(`[sse] Client disconnected (total: ${clients.size})`);
  });
}

/**
 * Broadcast a named event with a JSON payload to every connected client.
 *
 * @param {string} event  - SSE event name
 * @param {unknown} data  - payload (will be JSON-serialised)
 */
export function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of clients) {
    client.write(payload);
  }
  console.log(`[sse] Broadcast "${event}" to ${clients.size} client(s)`);
}
