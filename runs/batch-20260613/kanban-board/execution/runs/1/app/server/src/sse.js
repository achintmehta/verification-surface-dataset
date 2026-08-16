/**
 * SSE (Server-Sent Events) module.
 * Manages active client connections and broadcasts events to all of them.
 */

const clients = new Set();

/**
 * Register an SSE response object as an active client.
 * Automatically removes it when the connection closes.
 */
export function addClient(res) {
  clients.add(res);
  res.on('close', () => {
    clients.delete(res);
    console.log(`[sse] client disconnected (${clients.size} remaining)`);
  });
  console.log(`[sse] client connected (${clients.size} total)`);
}

/**
 * Broadcast a named event with a JSON payload to every connected client.
 * @param {string} event  - SSE event name
 * @param {object} data   - payload (will be JSON-serialized)
 */
export function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) {
    try {
      res.write(payload);
    } catch (err) {
      // If writing fails the 'close' handler will clean up
      console.error('[sse] write error, dropping client:', err.message);
      clients.delete(res);
    }
  }
}

export function clientCount() {
  return clients.size;
}
