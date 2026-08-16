/**
 * Manages a set of SSE client connections and broadcasts seat-status changes.
 */
export class SSEHub {
  constructor() {
    /** @type {Set<import('http').ServerResponse>} */
    this.clients = new Set();
    this._nextId = 1;
  }

  /** Register a new SSE connection (an Express response). */
  addClient(res) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    // Initial comment to open the stream.
    res.write(': connected\n\n');
    this.clients.add(res);

    // Heartbeat to keep proxies from closing idle connections.
    const heartbeat = setInterval(() => {
      try {
        res.write(': ping\n\n');
      } catch {
        /* ignore */
      }
    }, 25_000);

    const cleanup = () => {
      clearInterval(heartbeat);
      this.clients.delete(res);
    };
    res.on('close', cleanup);
    res.on('error', cleanup);
  }

  /**
   * Broadcast a named event with a JSON payload to all connected clients.
   * @param {string} event
   * @param {object} data
   */
  broadcast(event, data) {
    const id = this._nextId++;
    const payload = `id: ${id}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of this.clients) {
      try {
        res.write(payload);
      } catch {
        this.clients.delete(res);
      }
    }
  }

  /** Convenience: broadcast a batch of seat changes. */
  broadcastChanges(changes) {
    if (!changes || changes.length === 0) return;
    this.broadcast('seats', { changes });
  }

  get size() {
    return this.clients.size;
  }
}
