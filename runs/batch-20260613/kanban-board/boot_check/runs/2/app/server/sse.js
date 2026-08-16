/**
 * SSE connection manager.
 * Keeps track of all active EventSource clients and provides
 * a broadcast helper used by mutation handlers.
 */

const clients = new Set();

/**
 * Register an SSE response object and clean up when the connection closes.
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

  // Heartbeat every 25 s to prevent proxy timeouts
  const heartbeat = setInterval(() => {
    res.write(': heartbeat\n\n');
  }, 25_000);

  req.on('close', () => {
    clearInterval(heartbeat);
    clients.delete(res);
    console.log(`[sse] Client disconnected. Total: ${clients.size}`);
  });
}

/**
 * Broadcast a named event with a JSON payload to all connected clients.
 * @param {string} event  - SSE event name
 * @param {object} data   - payload (will be JSON-serialised)
 */
export function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  let dead = [];
  for (const res of clients) {
    try {
      res.write(payload);
    } catch {
      dead.push(res);
    }
  }
  for (const res of dead) clients.delete(res);
  console.log(`[sse] Broadcast "${event}" to ${clients.size} client(s).`);
}
