/**
 * sse.js – Server-Sent Events connection registry and broadcast helpers.
 *
 * Every client that opens GET /api/stream gets an SSE response added to the
 * `clients` Set.  Any server mutation calls `broadcast()` to push the
 * canonical state to every connected client.
 */

/** @type {Set<import('express').Response>} */
const clients = new Set();

/**
 * Register a new SSE client response.
 * Configures the necessary headers and removes the client when it disconnects.
 *
 * @param {import('express').Request}  req
 * @param {import('express').Response} res
 */
export function addClient(req, res) {
  res.set({
    'Content-Type':  'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection':    'keep-alive',
    // Disable response buffering in proxies / nginx
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();

  // Send a comment heartbeat immediately so the browser knows the stream is
  // alive, then repeat every 25 s to prevent proxy timeouts.
  res.write(': connected\n\n');
  const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), 25_000);

  clients.add(res);

  req.on('close', () => {
    clearInterval(heartbeat);
    clients.delete(res);
  });
}

/**
 * Broadcast a named SSE event with a JSON payload to every connected client.
 *
 * @param {string} event  – SSE event name (e.g. "card:created", "card:moved")
 * @param {unknown} data  – Anything JSON-serialisable
 */
export function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) {
    try {
      res.write(payload);
    } catch {
      // Client already gone; clean up.
      clients.delete(res);
    }
  }
}

/**
 * Broadcast a "board:reorder" event carrying the full canonical ordering for
 * one or more columns.  Used after position renormalisation.
 *
 * @param {Array<{ columnId: string, cards: Array<{ id: string, position: number }> }>} columns
 */
export function broadcastReorder(columns) {
  broadcast('board:reorder', { columns });
}
