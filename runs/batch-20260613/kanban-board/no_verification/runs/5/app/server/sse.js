/**
 * SSE (Server-Sent Events) connection manager.
 *
 * Maintains a set of active response objects and provides a broadcast helper.
 */

const clients = new Set();

/**
 * Register a new SSE client.
 * @param {import('express').Request}  req
 * @param {import('express').Response} res
 */
export function addClient(req, res) {
  // SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // disable nginx buffering if present
  res.flushHeaders();

  // Send a comment to keep the connection alive immediately
  res.write(': connected\n\n');

  clients.add(res);
  console.log(`[sse] Client connected. Total: ${clients.size}`);

  // Keep-alive ping every 20 s
  const keepAlive = setInterval(() => {
    if (!res.writableEnded) {
      res.write(': ping\n\n');
    }
  }, 20_000);

  req.on('close', () => {
    clearInterval(keepAlive);
    clients.delete(res);
    console.log(`[sse] Client disconnected. Total: ${clients.size}`);
  });
}

/**
 * Broadcast an event to all connected SSE clients.
 * @param {string} event  - SSE event name
 * @param {object} data   - JSON-serialisable payload
 */
export function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
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
  console.log(`[sse] Broadcast "${event}" to ${clients.size} client(s).`);
}
