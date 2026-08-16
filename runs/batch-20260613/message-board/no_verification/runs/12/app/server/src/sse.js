/**
 * Tiny Server-Sent Events hub.
 *
 * Keeps track of every active client connection (one per browser tab) and
 * provides a broadcast helper so newly inserted messages can be pushed to all
 * of them instantly.
 */

const clients = new Set();

/**
 * Register a new SSE client. Wires up the proper headers and removes the
 * client automatically when the connection closes.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
export function addClient(req, res) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    // Allow cross-origin EventSource connections (e.g. Vite dev server).
    "Access-Control-Allow-Origin": "*",
    "X-Accel-Buffering": "no",
  });

  // Flush headers immediately so the browser knows the stream is open.
  res.write("retry: 3000\n\n");
  // An initial comment / event lets the client know it is connected.
  res.write(`event: connected\ndata: ${JSON.stringify({ ok: true })}\n\n`);

  clients.add(res);
  console.log(`[sse] client connected (total: ${clients.size})`);

  // Heartbeat keeps proxies from closing idle connections.
  const heartbeat = setInterval(() => {
    res.write(`: keep-alive ${Date.now()}\n\n`);
  }, 25000);

  req.on("close", () => {
    clearInterval(heartbeat);
    clients.delete(res);
    console.log(`[sse] client disconnected (total: ${clients.size})`);
  });
}

/**
 * Broadcast a payload to every connected SSE client.
 *
 * @param {string} event - the SSE event name
 * @param {unknown} data - JSON-serialisable payload
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
