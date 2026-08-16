/** Manages active SSE client connections and broadcasts messages. */

const clients = new Set();

/**
 * Add a new SSE client.  Returns a remove function.
 */
export function addClient(res) {
  clients.add(res);
  return () => clients.delete(res);
}

/**
 * Broadcast a message object to every connected SSE client.
 */
export function broadcast(message) {
  const data = JSON.stringify(message);
  for (const client of clients) {
    client.write(`data: ${data}\n\n`);
  }
}
