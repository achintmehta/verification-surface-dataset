/**
 * SSE (Server-Sent Events) connection manager.
 *
 * Maintains a set of active response objects and provides a broadcast helper.
 * Each event is a JSON-encoded payload sent as `data: <json>\n\n`.
 *
 * Event shapes:
 *   { type: 'card:created', card }
 *   { type: 'card:moved',   card }
 *   { type: 'column:reordered', columnId, cards }   – after position renormalisation
 *   { type: 'board:state',  columns }               – full board snapshot (on connect)
 */

/** @type {Set<import('express').Response>} */
const clients = new Set();

/**
 * Register a new SSE client.
 * Sets the required headers and removes the client on disconnect.
 *
 * @param {import('express').Request}  req
 * @param {import('express').Response} res
 */
export function addClient(req, res) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // disable nginx buffering if present
  res.flushHeaders();

  // Send a comment heartbeat immediately so the browser knows the stream is live
  res.write(': connected\n\n');

  clients.add(res);
  console.log(`[sse] Client connected. Total: ${clients.size}`);

  // Keep-alive ping every 25 s to prevent proxy timeouts
  const heartbeat = setInterval(() => {
    if (res.writableEnded) {
      clearInterval(heartbeat);
      return;
    }
    res.write(': ping\n\n');
  }, 25_000);

  req.on('close', () => {
    clearInterval(heartbeat);
    clients.delete(res);
    console.log(`[sse] Client disconnected. Total: ${clients.size}`);
  });
}

/**
 * Broadcast a JSON event to all connected clients.
 *
 * @param {string} eventType  – the SSE `event:` field (e.g. 'card:created')
 * @param {object} payload    – will be JSON-serialised into the `data:` field
 */
export function broadcast(eventType, payload) {
  const message = `event: ${eventType}\ndata: ${JSON.stringify(payload)}\n\n`;
  let dead = [];
  for (const res of clients) {
    if (res.writableEnded) {
      dead.push(res);
      continue;
    }
    res.write(message);
  }
  // Prune any stale connections discovered during broadcast
  for (const res of dead) clients.delete(res);

  if (clients.size > 0) {
    console.log(`[sse] Broadcast '${eventType}' to ${clients.size} client(s).`);
  }
}

/** Return the current number of connected SSE clients (for diagnostics). */
export function clientCount() {
  return clients.size;
}
