/**
 * Registry of active SSE connections and helpers for broadcasting events.
 */

/** @type {Set<import("express").Response>} */
const clients = new Set();

/**
 * Initialise an SSE connection on the given Express response.
 * Sets the required headers, sends an initial comment to flush the
 * connection, and registers a cleanup handler for when the client
 * disconnects.
 *
 * @param {import("express").Request}  _req
 * @param {import("express").Response} res
 */
export function addClient(_req, res) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  // Send an initial comment so the connection is fully established.
  res.write(": connected\n\n");

  clients.add(res);

  _req.on("close", () => {
    clients.delete(res);
  });
}

/**
 * Broadcast a named event + JSON payload to every connected SSE client.
 *
 * @param {string} event  – the SSE event name (e.g. "new-message")
 * @param {unknown} data  – JSON-serialisable payload
 */
export function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of clients) {
    client.write(payload);
  }
}
