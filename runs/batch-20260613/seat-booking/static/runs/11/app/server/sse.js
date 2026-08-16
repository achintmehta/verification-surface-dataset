// Server-Sent Events connection registry and broadcaster.
const clients = new Set();

/**
 * Register a new SSE client (an Express response object configured for SSE).
 */
export function addClient(res) {
  clients.add(res);
  res.on('close', () => {
    clients.delete(res);
  });
}

/**
 * Broadcast an event to all connected SSE clients.
 * @param {string} event - event name
 * @param {object} data - JSON-serializable payload
 */
export function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
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
