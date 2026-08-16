/**
 * A very small Server-Sent Events (SSE) hub.
 *
 * It keeps track of every active client connection (an Express response object)
 * and exposes a `broadcast` helper to push an event payload to all of them at
 * once. This is how we deliver new messages to every connected browser tab in
 * real time without WebSockets.
 */
export class SseHub {
  constructor() {
    /** @type {Set<import('express').Response>} */
    this.clients = new Set();
  }

  /**
   * Register a new SSE client. Sets the appropriate streaming headers and keeps
   * the connection open. The client is automatically removed when it
   * disconnects.
   *
   * @param {import('express').Request} req
   * @param {import('express').Response} res
   */
  addClient(req, res) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      // Disable proxy buffering (e.g. nginx) so events flush immediately.
      'X-Accel-Buffering': 'no',
    });

    // Flush headers right away so the browser knows the stream is open.
    res.write('retry: 3000\n\n');

    this.clients.add(res);

    // Send a periodic comment as a heartbeat to keep the connection alive
    // through proxies and detect dead connections.
    const heartbeat = setInterval(() => {
      res.write(': heartbeat\n\n');
    }, 25000);

    const cleanup = () => {
      clearInterval(heartbeat);
      this.clients.delete(res);
    };

    req.on('close', cleanup);
    res.on('error', cleanup);
  }

  /**
   * Broadcast a named event with a JSON payload to every connected client.
   *
   * @param {string} event - the SSE event name
   * @param {unknown} data - any JSON-serialisable payload
   */
  broadcast(event, data) {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of this.clients) {
      res.write(payload);
    }
  }

  /** Number of currently connected clients. */
  get size() {
    return this.clients.size;
  }
}

export const sseHub = new SseHub();
