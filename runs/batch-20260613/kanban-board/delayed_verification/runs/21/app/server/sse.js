/**
 * SSE connection manager.
 * Keeps track of connected clients and broadcasts events.
 */
export function createSSEManager() {
  let nextId = 1;
  const clients = new Map(); // clientId -> response

  function addClient(res) {
    const id = nextId++;
    clients.set(id, res);
    return id;
  }

  function removeClient(id) {
    clients.delete(id);
  }

  /**
   * Broadcast an event to all connected clients.
   * @param {string} event - Event name
   * @param {object} data - Payload
   */
  function broadcast(event, data) {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const [id, res] of clients) {
      try {
        res.write(payload);
      } catch {
        clients.delete(id);
      }
    }
  }

  return { addClient, removeClient, broadcast };
}
