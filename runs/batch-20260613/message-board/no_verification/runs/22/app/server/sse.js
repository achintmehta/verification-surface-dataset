/**
 * Manages Server-Sent Event connections and broadcasting.
 */

/** @type {Set<import('express').Response>} */
const clients = new Set();

/**
 * Register a new SSE client connection.
 * Sets proper headers, adds the response to the active set,
 * and removes it on close.
 *
 * @param {import('express').Request} _req
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
  console.log(`[sse] client connected  (total: ${clients.size})`);

  _req.on("close", () => {
    clients.delete(res);
    console.log(`[sse] client disconnected (total: ${clients.size})`);
  });
}

/**
 * Broadcast a message object to every connected SSE client.
 *
 * @param {object} message  – the message row to broadcast
 */
export function broadcast(message) {
  const payload = `data: ${JSON.stringify(message)}\n\n`;
  for (const client of clients) {
    client.write(payload);
  }
}
