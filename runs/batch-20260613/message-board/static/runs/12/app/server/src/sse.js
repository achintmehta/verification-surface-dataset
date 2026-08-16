/**
 * A minimal Server-Sent Events broker.
 *
 * Keeps track of every active client connection (an Express `Response`)
 * and provides a `broadcast` helper to push events to all of them.
 */
class SseBroker {
  constructor() {
    /** @type {Set<import("express").Response>} */
    this.clients = new Set();
  }

  /**
   * Register a new SSE client. Sets the appropriate headers and keeps the
   * connection open. Returns a cleanup function to call on disconnect.
   *
   * @param {import("express").Request} req
   * @param {import("express").Response} res
   */
  addClient(req, res) {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      // Disable proxy buffering so events flush immediately.
      "X-Accel-Buffering": "no",
    });

    // Flush the headers and send an initial comment to open the stream.
    res.write(": connected\n\n");

    // Periodic heartbeat keeps intermediaries from closing idle connections.
    const heartbeat = setInterval(() => {
      res.write(": ping\n\n");
    }, 25000);

    this.clients.add(res);

    const cleanup = () => {
      clearInterval(heartbeat);
      this.clients.delete(res);
    };

    req.on("close", cleanup);
    return cleanup;
  }

  /**
   * Broadcast a named event with a JSON payload to all connected clients.
   *
   * @param {string} event
   * @param {unknown} data
   */
  broadcast(event, data) {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const client of this.clients) {
      client.write(payload);
    }
  }

  get connectionCount() {
    return this.clients.size;
  }
}

export const sseBroker = new SseBroker();
