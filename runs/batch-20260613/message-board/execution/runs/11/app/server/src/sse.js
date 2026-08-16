/**
 * A tiny in-memory registry of active Server-Sent Events connections.
 * Each connected client is represented by its Express `res` object.
 */
const clients = new Set();

/**
 * Register a new SSE client connection and configure the response stream.
 */
export function addClient(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    // Helpful when sitting behind proxies that buffer responses.
    'X-Accel-Buffering': 'no',
  });

  // Flush headers immediately so the browser opens the stream.
  res.write('retry: 3000\n\n');
  // A friendly comment so the connection has activity right away.
  res.write(': connected\n\n');

  clients.add(res);

  // Keep the connection alive through idle proxies with periodic comments.
  const heartbeat = setInterval(() => {
    res.write(': ping\n\n');
  }, 25000);

  req.on('close', () => {
    clearInterval(heartbeat);
    clients.delete(res);
  });
}

/**
 * Broadcast a named event with a JSON payload to every connected client.
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
