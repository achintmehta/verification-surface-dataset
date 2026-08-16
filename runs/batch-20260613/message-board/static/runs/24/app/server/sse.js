/**
 * A lightweight manager for Server-Sent Event connections.
 *
 * Each connected client is represented by a standard Express `Response` object
 * that has been configured for SSE streaming. The manager provides helpers to
 * add / remove connections and to broadcast a JSON payload to every active
 * client.
 */

/** @typedef {import("express").Response} Response */

/** @type {Set<Response>} */
const clients = new Set();

/**
 * Register a new SSE client. Sets appropriate headers and sends an initial
 * comment so the connection is fully established. Automatically removes the
 * client when the underlying TCP connection closes.
 *
 * @param {Response} res – Express response object to use for SSE streaming.
 */
export function addClient(res) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  // Send an initial comment to flush headers / confirm connection.
  res.write(":ok\n\n");

  clients.add(res);

  res.on("close", () => {
    clients.delete(res);
  });
}

/**
 * Broadcast a named event with a JSON-serialisable payload to every connected
 * SSE client.
 *
 * @param {string} event – The SSE event name (e.g. "new-message").
 * @param {unknown} data  – Any JSON-serialisable value.
 */
export function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of clients) {
    client.write(payload);
  }
}
