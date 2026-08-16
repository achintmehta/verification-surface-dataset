/**
 * sse.js – Manages the pool of active Server-Sent Event connections and
 * provides a broadcast helper used by the messages route.
 *
 * Each connected client is stored as a plain object:
 *   { id: string, res: express.Response }
 *
 * When a new message is inserted the messages route calls `broadcast()` which
 * serialises the message as a JSON SSE `data:` frame and flushes it to every
 * active connection.
 */

/** @type {Map<string, import("express").Response>} */
const clients = new Map();

let _nextId = 1;

/**
 * Express route handler for GET /api/stream.
 *
 * Sets the correct SSE headers, registers the response in the client pool,
 * sends an initial `connected` event so the browser knows the stream is live,
 * and cleans up when the connection closes.
 *
 * @param {import("express").Request}  req
 * @param {import("express").Response} res
 */
export function sseHandler(req, res) {
  const clientId = String(_nextId++);

  // Required SSE headers.
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  // Disable response buffering in Express / Node so events are flushed
  // immediately.
  res.flushHeaders();

  // Send a heartbeat comment every 25 s to keep the connection alive through
  // proxies and load-balancers that close idle connections.
  const heartbeat = setInterval(() => {
    res.write(": heartbeat\n\n");
  }, 25_000);

  // Notify the client that the stream is open.
  sendEvent(res, "connected", { clientId });

  clients.set(clientId, res);
  console.log(`[sse] Client ${clientId} connected  (total: ${clients.size})`);

  // Clean up when the client disconnects (tab closed, navigation, etc.).
  req.on("close", () => {
    clearInterval(heartbeat);
    clients.delete(clientId);
    console.log(
      `[sse] Client ${clientId} disconnected (total: ${clients.size})`
    );
  });
}

/**
 * Broadcast a new message to every connected SSE client.
 *
 * @param {{ id: number, text: string, created_at: string }} message
 */
export function broadcast(message) {
  if (clients.size === 0) return;

  console.log(`[sse] Broadcasting message ${message.id} to ${clients.size} client(s)`);

  for (const [id, res] of clients) {
    try {
      sendEvent(res, "message", message);
    } catch (err) {
      // If writing fails the connection is stale – remove it.
      console.warn(`[sse] Removing stale client ${id}:`, err.message);
      clients.delete(id);
    }
  }
}

/**
 * Write a single SSE event frame to a response stream.
 *
 * SSE frame format:
 *   event: <eventName>\n
 *   data: <jsonPayload>\n
 *   \n
 *
 * @param {import("express").Response} res
 * @param {string} eventName
 * @param {unknown} payload
 */
function sendEvent(res, eventName, payload) {
  res.write(`event: ${eventName}\ndata: ${JSON.stringify(payload)}\n\n`);
}
