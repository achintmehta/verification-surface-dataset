/**
 * SSE connection manager.
 *
 * Keeps track of every active SSE `Response` object and exposes helpers to
 * add / remove connections and broadcast JSON payloads to all of them.
 */

/** @typedef {import("express").Response} Response */

/** @type {Set<Response>} */
const clients = new Set();

/**
 * Register a new SSE client response. Sets the required headers and sends an
 * initial comment so the connection is established immediately.
 *
 * @param {Response} res
 */
export function addClient(res) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  // Send an initial comment to flush headers / confirm the connection.
  res.write(": connected\n\n");

  clients.add(res);
}

/**
 * Remove an SSE client (e.g. when the underlying TCP socket closes).
 *
 * @param {Response} res
 */
export function removeClient(res) {
  clients.delete(res);
}

/**
 * Broadcast a named event + JSON payload to every connected SSE client.
 *
 * @param {string}  event  – the SSE event name (e.g. "new-message")
 * @param {unknown} data   – any JSON-serialisable value
 */
export function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of clients) {
    client.write(payload);
  }
}
