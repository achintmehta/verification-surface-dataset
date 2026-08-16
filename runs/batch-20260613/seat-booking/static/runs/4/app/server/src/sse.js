/**
 * SSE (Server-Sent Events) broadcast module.
 *
 * Maintains a registry of active response streams and provides a `broadcast`
 * helper that pushes a typed event to every connected client.
 */

/** @type {Set<import('express').Response>} */
const clients = new Set();

/**
 * Register an Express response object as an SSE stream.
 * Sends the required headers and an initial `connected` event.
 *
 * @param {import('express').Request}  req
 * @param {import('express').Response} res
 */
export function addClient(req, res) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // disable nginx buffering
  res.flushHeaders();

  // Send a heartbeat comment immediately so the browser knows the stream is live
  res.write(': connected\n\n');

  clients.add(res);

  // Clean up when the client disconnects
  req.on('close', () => {
    clients.delete(res);
  });
}

/**
 * Broadcast a JSON payload to every connected SSE client.
 *
 * @param {string}  eventName  – the SSE `event:` field
 * @param {unknown} data       – will be JSON-serialised into the `data:` field
 */
export function broadcast(eventName, data) {
  const payload = `event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) {
    try {
      res.write(payload);
    } catch {
      // Client already gone; remove it
      clients.delete(res);
    }
  }
}

/**
 * Send a periodic heartbeat comment to all clients to keep connections alive
 * through proxies / load-balancers that close idle streams.
 */
export function startHeartbeat(intervalMs = 15_000) {
  setInterval(() => {
    for (const res of clients) {
      try {
        res.write(': heartbeat\n\n');
      } catch {
        clients.delete(res);
      }
    }
  }, intervalMs);
}
