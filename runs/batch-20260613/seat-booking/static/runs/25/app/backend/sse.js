/**
 * SSE connection manager.
 * Maintains a set of active response objects and broadcasts events to all.
 */

/** @type {Set<import('express').Response>} */
const clients = new Set();

/**
 * Register a new SSE client connection.
 * @param {import('express').Request} _req
 * @param {import('express').Response} res
 */
export function addClient(_req, res) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.write(":\n\n"); // comment to establish connection

  clients.add(res);

  // Send a heartbeat every 15 seconds to keep the connection alive
  const heartbeat = setInterval(() => {
    res.write(":\n\n");
  }, 15000);

  _req.on("close", () => {
    clearInterval(heartbeat);
    clients.delete(res);
  });
}

/**
 * Broadcast an event to all connected SSE clients.
 * @param {string} event - event name
 * @param {unknown} data - JSON-serializable data
 */
export function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of clients) {
    client.write(payload);
  }
}

/**
 * Get the number of connected clients (for diagnostics).
 * @returns {number}
 */
export function clientCount() {
  return clients.size;
}
