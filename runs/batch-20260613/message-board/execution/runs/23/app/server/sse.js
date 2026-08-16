/** @type {Set<import('express').Response>} */
const clients = new Set();

/**
 * Register a new SSE client connection.
 * Sets the appropriate headers and keeps the connection alive.
 */
export function addClient(req, res) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  // Send an initial comment so the client knows the connection is alive
  res.write(":connected\n\n");

  clients.add(res);
  console.log(`[sse] Client connected (total: ${clients.size})`);

  req.on("close", () => {
    clients.delete(res);
    console.log(`[sse] Client disconnected (total: ${clients.size})`);
  });
}

/**
 * Broadcast a message object to every connected SSE client.
 * Uses the "message" event name (default for EventSource).
 */
export function broadcast(message) {
  const data = JSON.stringify(message);
  for (const client of clients) {
    client.write(`data: ${data}\n\n`);
  }
}
