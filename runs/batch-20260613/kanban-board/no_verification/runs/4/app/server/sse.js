/**
 * SSE (Server-Sent Events) connection registry and broadcast helpers.
 *
 * Each connected client gets a persistent HTTP response with
 * Content-Type: text/event-stream.  We keep a Set of active response
 * objects and fan-out every mutation to all of them.
 */

const clients = new Set();

/**
 * Register a new SSE client.
 * Sets the required headers and adds the response to the active set.
 * Removes the client when the connection closes.
 */
export function addClient(req, res) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // Disable nginx buffering if present.
  res.flushHeaders();

  // Send a comment to keep the connection alive immediately.
  res.write(': connected\n\n');

  clients.add(res);
  console.log(`[sse] Client connected. Total: ${clients.size}`);

  // Clean up when the client disconnects.
  req.on('close', () => {
    clients.delete(res);
    console.log(`[sse] Client disconnected. Total: ${clients.size}`);
  });
}

/**
 * Broadcast a named event with a JSON payload to all connected clients.
 */
export function broadcast(eventName, data) {
  const payload = `event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`;
  let dead = [];
  for (const res of clients) {
    try {
      res.write(payload);
    } catch {
      dead.push(res);
    }
  }
  for (const res of dead) clients.delete(res);
  console.log(
    `[sse] Broadcast "${eventName}" to ${clients.size} client(s).`
  );
}
