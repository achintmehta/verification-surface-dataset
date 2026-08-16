/**
 * SSE connection manager.
 * Keeps track of all active EventSource clients and provides a broadcast helper.
 */

const clients = new Set();

/**
 * Register an SSE response object.
 * Sends the required headers and keeps the connection alive.
 */
export function addClient(req, res) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // disable nginx buffering if present
  res.flushHeaders();

  // Send a comment to establish the connection immediately
  res.write(': connected\n\n');

  clients.add(res);
  console.log(`[sse] Client connected (total: ${clients.size})`);

  // Keep-alive ping every 20 seconds
  const ping = setInterval(() => {
    try {
      res.write(': ping\n\n');
    } catch {
      clearInterval(ping);
    }
  }, 20_000);

  req.on('close', () => {
    clearInterval(ping);
    clients.delete(res);
    console.log(`[sse] Client disconnected (total: ${clients.size})`);
  });
}

/**
 * Broadcast an event to all connected SSE clients.
 * @param {string} event  - SSE event name
 * @param {object} data   - JSON-serializable payload
 */
export function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  const dead = [];

  for (const res of clients) {
    try {
      res.write(payload);
    } catch {
      dead.push(res);
    }
  }

  for (const res of dead) clients.delete(res);

  if (clients.size > 0) {
    console.log(`[sse] Broadcast "${event}" to ${clients.size} client(s)`);
  }
}
