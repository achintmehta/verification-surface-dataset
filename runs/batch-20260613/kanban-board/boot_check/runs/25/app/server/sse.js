/**
 * SSE connection manager.
 * Maintains a set of active response objects and broadcasts events.
 */
export function createSSEManager() {
  const clients = new Set();

  function addClient(req, res) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(':\n\n'); // comment to flush headers

    clients.add(res);

    req.on('close', () => {
      clients.delete(res);
    });
  }

  /**
   * Broadcast an event to all connected clients.
   * @param {string} event - event name
   * @param {object} data  - JSON-serializable payload
   */
  function broadcast(event, data) {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const client of clients) {
      client.write(payload);
    }
  }

  return { addClient, broadcast, clients };
}
