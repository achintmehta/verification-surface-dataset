/**
 * Manages active SSE (Server-Sent Events) client connections.
 * Provides helpers to add/remove clients and broadcast messages.
 */

/** @type {Set<import("express").Response>} */
const clients = new Set();

/**
 * Register a new SSE client response.
 * Sets the required headers and sends an initial comment to keep the
 * connection alive. When the client disconnects, it is automatically removed.
 *
 * @param {import("express").Request} _req
 * @param {import("express").Response} res
 */
export function addClient(_req, res) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  // Send an initial comment so the client knows the connection is alive
  res.write(": connected\n\n");

  clients.add(res);
  console.log(`[sse] Client connected  (total: ${clients.size})`);

  _req.on("close", () => {
    clients.delete(res);
    console.log(`[sse] Client disconnected (total: ${clients.size})`);
  });
}

/**
 * Broadcast a message object to every connected SSE client.
 *
 * @param {object} message – the message row to broadcast
 */
export function broadcast(message) {
  const payload = `data: ${JSON.stringify(message)}\n\n`;
  for (const client of clients) {
    client.write(payload);
  }
}
