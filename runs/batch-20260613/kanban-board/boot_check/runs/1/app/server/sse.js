/**
 * SSE connection manager.
 * Keeps a set of active response objects and provides a broadcast helper.
 */

const clients = new Set();

/**
 * Register a new SSE client.
 * @param {import('express').Request}  req
 * @param {import('express').Response} res
 */
export function addClient(req, res) {
  res.set({
    'Content-Type':  'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection':    'keep-alive',
    'X-Accel-Buffering': 'no',   // disable nginx buffering if present
  });
  res.flushHeaders();

  // Send a heartbeat comment immediately so the browser knows the stream is live
  res.write(': connected\n\n');

  clients.add(res);
  console.log(`[sse] client connected  (total: ${clients.size})`);

  // Heartbeat every 25 s to keep the connection alive through proxies
  const heartbeat = setInterval(() => {
    if (!res.writableEnded) res.write(': heartbeat\n\n');
  }, 25_000);

  req.on('close', () => {
    clearInterval(heartbeat);
    clients.delete(res);
    console.log(`[sse] client disconnected (total: ${clients.size})`);
  });
}

/**
 * Broadcast a named event with a JSON payload to every connected client.
 * @param {string} event  – SSE event name
 * @param {object} data   – will be JSON-serialised
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
  // Clean up any stale connections found during broadcast
  for (const res of dead) clients.delete(res);
  console.log(`[sse] broadcast "${event}" to ${clients.size} client(s)`);
}
