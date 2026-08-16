/**
 * Lightweight Server-Sent Events (SSE) connection manager.
 *
 * Keeps track of all currently connected clients so that newly created
 * messages can be broadcast to every open connection.
 */

// Set of active Express `res` objects representing open SSE streams.
const clients = new Set();

/**
 * Register a new SSE client. Sets the appropriate headers, sends an initial
 * comment to establish the stream, and starts a heartbeat to keep the
 * connection alive through proxies.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
export function addClient(req, res) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });

  // Flush headers so the client opens the stream immediately.
  res.write(": connected\n\n");
  if (typeof res.flushHeaders === "function") {
    res.flushHeaders();
  }

  clients.add(res);
  console.log(`[sse] client connected (total: ${clients.size})`);

  // Heartbeat every 25s to prevent idle connections from being dropped.
  const heartbeat = setInterval(() => {
    res.write(": heartbeat\n\n");
  }, 25000);

  const cleanup = () => {
    clearInterval(heartbeat);
    clients.delete(res);
    console.log(`[sse] client disconnected (total: ${clients.size})`);
  };

  req.on("close", cleanup);
  res.on("error", cleanup);
}

/**
 * Broadcast an event to every connected SSE client.
 *
 * @param {string} event - the named SSE event (e.g. "message")
 * @param {unknown} data - JSON-serializable payload
 */
export function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) {
    res.write(payload);
  }
}

export function clientCount() {
  return clients.size;
}
