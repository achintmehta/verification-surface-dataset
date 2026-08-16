/**
 * Manages Server-Sent Event (SSE) connections.
 *
 * - addClient(res)      – registers/configures a new SSE response stream
 * - removeClient(res)   – removes a disconnected client
 * - broadcast(event, data) – pushes a named event to every connected client
 */

/** @type {Set<import('express').Response>} */
const clients = new Set();

/**
 * Configure the Express response for SSE and add it to the active set.
 * Returns nothing – the response stays open until the client disconnects.
 */
export function addClient(req, res) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  // Send an initial comment so proxies don't close the connection early.
  res.write(": connected\n\n");

  clients.add(res);

  // Clean up when the client disconnects.
  req.on("close", () => {
    clients.delete(res);
  });
}

/**
 * Broadcast a named SSE event to every connected client.
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
