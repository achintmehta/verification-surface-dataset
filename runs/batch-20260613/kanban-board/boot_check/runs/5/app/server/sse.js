/**
 * SSE connection manager.
 * Keeps track of all active EventSource clients and provides
 * a broadcast helper used by mutation handlers.
 */

const clients = new Set();

/**
 * Register an SSE response object and clean up when the connection closes.
 */
export function addClient(res) {
  clients.add(res);
  res.on('close', () => {
    clients.delete(res);
    console.log(`[sse] client disconnected – ${clients.size} remaining`);
  });
  console.log(`[sse] client connected – ${clients.size} total`);
}

/**
 * Broadcast a named event with a JSON payload to every connected client.
 */
export function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) {
    try {
      res.write(payload);
    } catch (err) {
      console.error('[sse] write error, removing client', err.message);
      clients.delete(res);
    }
  }
}
