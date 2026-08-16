/**
 * A tiny Server-Sent Events hub that tracks active client connections and
 * broadcasts messages to all of them.
 */
class SseHub {
  constructor() {
    /** @type {Set<import('express').Response>} */
    this.clients = new Set();
    this._nextId = 1;
  }

  /**
   * Register a new SSE client. Sets the appropriate headers, keeps the
   * connection open, and wires up cleanup on disconnect.
   * @param {import('express').Request} req
   * @param {import('express').Response} res
   */
  addClient(req, res) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    // Flush headers immediately so the EventSource fires `onopen`.
    res.write('retry: 3000\n\n');

    const clientId = this._nextId++;
    this.clients.add(res);
    console.log(`[sse] client #${clientId} connected (${this.clients.size} total)`);

    // Heartbeat keeps proxies / browsers from closing idle connections.
    const heartbeat = setInterval(() => {
      res.write(': ping\n\n');
    }, 25000);

    const cleanup = () => {
      clearInterval(heartbeat);
      this.clients.delete(res);
      console.log(`[sse] client #${clientId} disconnected (${this.clients.size} total)`);
    };

    req.on('close', cleanup);
    res.on('error', cleanup);
  }

  /**
   * Broadcast an event to every connected client.
   * @param {string} event - the SSE event name
   * @param {unknown} data - JSON-serializable payload
   */
  broadcast(event, data) {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of this.clients) {
      res.write(payload);
    }
  }

  get clientCount() {
    return this.clients.size;
  }
}

export const sseHub = new SseHub();
