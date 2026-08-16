/**
 * SSE (Server-Sent Events) connection manager.
 * Maintains a set of active response objects and broadcasts events to all.
 */

/** @type {Set<import('express').Response>} */
const clients = new Set();

/**
 * Register a new SSE client connection.
 * Sets the appropriate headers and adds the response to the client set.
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
  // Send an initial comment to establish the connection
  res.write(":connected\n\n");
  clients.add(res);

  // Remove on disconnect
  const onClose = () => {
    clients.delete(res);
  };
  _req.on("close", onClose);
  res.on("close", onClose);
}

/**
 * Broadcast an event to all connected SSE clients.
 * @param {string} event  - the event name
 * @param {unknown} data   - JSON-serialisable payload
 */
export function broadcast(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of clients) {
    client.write(msg);
  }
}

/**
 * Return the number of active SSE connections (for diagnostics).
 * @returns {number}
 */
export function clientCount() {
  return clients.size;
}
