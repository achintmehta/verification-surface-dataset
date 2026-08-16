/**
 * Minimal Server-Sent Events hub. Tracks connected clients and broadcasts
 * seat-change events to all of them.
 */
export class SseHub {
  constructor() {
    /** @type {Set<import('http').ServerResponse>} */
    this.clients = new Set();
    this._nextId = 1;
  }

  /** Attach a new SSE client (an Express response). */
  addClient(req, res) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    // Initial comment to open the stream.
    res.write(': connected\n\n');
    this.clients.add(res);

    // Heartbeat keeps proxies from closing idle connections.
    const heartbeat = setInterval(() => {
      try {
        res.write(': ping\n\n');
      } catch {
        /* will be cleaned up on close */
      }
    }, 25000);

    const cleanup = () => {
      clearInterval(heartbeat);
      this.clients.delete(res);
    };
    req.on('close', cleanup);
    req.on('error', cleanup);
  }

  /** Broadcast an array of seat-change events to all clients. */
  broadcast(events) {
    if (!events || events.length === 0) return;
    const payload = JSON.stringify({ events, ts: Date.now() });
    const id = this._nextId++;
    const frame = `id: ${id}\nevent: seats\ndata: ${payload}\n\n`;
    for (const res of this.clients) {
      try {
        res.write(frame);
      } catch {
        this.clients.delete(res);
      }
    }
  }

  closeAll() {
    for (const res of this.clients) {
      try {
        res.end();
      } catch {
        /* ignore */
      }
    }
    this.clients.clear();
  }
}
