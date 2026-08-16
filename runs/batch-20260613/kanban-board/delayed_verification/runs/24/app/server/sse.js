// SSE connection manager
// Maintains a set of active SSE response objects and broadcasts events to all.

const clients = new Set();

/**
 * Register an SSE client (Express response object).
 * Sets appropriate headers and handles cleanup on close.
 */
export function addClient(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  // Send an initial comment to flush headers / confirm connection
  res.write(':connected\n\n');

  clients.add(res);

  req.on('close', () => {
    clients.delete(res);
  });
}

/**
 * Broadcast an event to every connected SSE client.
 * @param {string} event  - The event name (e.g. "card_created", "card_moved")
 * @param {object} data   - JSON-serialisable payload
 */
export function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of clients) {
    client.write(payload);
  }
}

export function clientCount() {
  return clients.size;
}
