/**
 * SSE connection manager.
 * Maintains a set of active response objects and provides broadcast helpers.
 */

/** @type {Set<import("express").Response>} */
const clients = new Set();

/**
 * Register a new SSE client connection.
 * Sets the appropriate headers and adds the response to the client set.
 * @param {import("express").Request} _req
 * @param {import("express").Response} res
 */
export function addClient(_req, res) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  // Send a comment line as a keep-alive / connection confirmation
  res.write(":ok\n\n");

  clients.add(res);

  // Remove client when connection closes
  _req.on("close", () => {
    clients.delete(res);
  });
}

/**
 * Broadcast an SSE event to all connected clients.
 * @param {string} event   – event name (e.g. "card-created", "card-moved")
 * @param {unknown} data   – JSON-serialisable payload
 */
export function broadcast(event, data) {
  const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) {
    res.write(frame);
  }
}
