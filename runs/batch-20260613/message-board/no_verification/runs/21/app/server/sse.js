/**
 * Lightweight SSE connection manager.
 *
 * Each connected client is stored with a unique ID so we can clean up when
 * the connection is closed.
 */

let nextClientId = 1;
const clients = new Map();

/**
 * Register a new SSE client (Express response object).
 * Returns the client ID for later removal.
 */
export function addClient(res) {
  const id = nextClientId++;
  clients.set(id, res);
  console.log(`SSE client connected   [id=${id}] (total: ${clients.size})`);
  return id;
}

/**
 * Remove an SSE client by ID (called when the connection closes).
 */
export function removeClient(id) {
  clients.delete(id);
  console.log(`SSE client disconnected [id=${id}] (total: ${clients.size})`);
}

/**
 * Broadcast a message object to every connected SSE client.
 * The event name sent is "message" (the default EventSource event).
 */
export function broadcast(message) {
  const data = JSON.stringify(message);
  for (const [id, res] of clients) {
    try {
      res.write(`data: ${data}\n\n`);
    } catch (err) {
      console.error(`Failed to write to SSE client ${id}:`, err);
      clients.delete(id);
    }
  }
}
