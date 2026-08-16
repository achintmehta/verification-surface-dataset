/**
 * Manages active SSE (Server-Sent Events) client connections and broadcasts
 * messages to all of them.
 */

/** @type {Set<import('express').Response>} */
const clients = new Set();

/**
 * Register a new SSE client connection.
 * Sets up the appropriate headers and handles cleanup on disconnect.
 *
 * @param {import('express').Request}  _req
 * @param {import('express').Response} res
 */
export function addClient(_req, res) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  // Send an initial comment to flush headers / confirm connection
  res.write(":connected\n\n");

  clients.add(res);

  // Remove client when connection closes
  _req.on("close", () => {
    clients.delete(res);
  });
}

/**
 * Broadcast a message object to every connected SSE client.
 *
 * @param {object} message  – the message row (id, text, created_at)
 */
export function broadcast(message) {
  const payload = `data: ${JSON.stringify(message)}\n\n`;
  for (const client of clients) {
    client.write(payload);
  }
}

/**
 * Return how many clients are currently connected – useful for tests / debugging.
 */
export function clientCount() {
  return clients.size;
}
