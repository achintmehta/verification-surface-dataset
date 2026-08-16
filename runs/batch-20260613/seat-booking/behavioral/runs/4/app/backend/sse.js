/**
 * SSE broadcaster – keeps a set of active response objects and
 * pushes named events to all of them.
 */

const clients = new Set();

/**
 * Register an Express response as an SSE client.
 * Cleans itself up when the connection closes.
 */
export function addClient(res) {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  // Send a heartbeat comment immediately so the browser knows it's connected
  res.write(": connected\n\n");

  clients.add(res);

  res.on("close", () => {
    clients.delete(res);
  });
}

/**
 * Broadcast a named event with a JSON payload to every connected client.
 * @param {string} event  – event name (e.g. "seat-update")
 * @param {object} data   – will be JSON-serialised
 */
export function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of clients) {
    try {
      client.write(payload);
    } catch {
      clients.delete(client);
    }
  }
}

export function clientCount() {
  return clients.size;
}
