// Simple in-memory registry of active SSE client connections.
const clients = new Set();

/**
 * Register a new SSE client (Express `res` object) and prepare the stream.
 */
export function addClient(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  // Send an initial comment to establish the stream and flush headers.
  res.write(': connected\n\n');

  clients.add(res);
  return () => clients.delete(res);
}

/**
 * Broadcast a JSON-serializable payload to every connected SSE client.
 */
export function broadcast(eventName, data) {
  const payload = `event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) {
    try {
      res.write(payload);
    } catch {
      clients.delete(res);
    }
  }
}

export function clientCount() {
  return clients.size;
}
