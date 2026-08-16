/**
 * Tracks active Server-Sent Events (SSE) connections and broadcasts
 * events to every connected client.
 */
class Broadcaster {
  constructor() {
    /** @type {Set<import('express').Response>} */
    this.clients = new Set();
  }

  /**
   * Register a new SSE client. The provided Express response must already
   * have the SSE headers written. Returns an unsubscribe function.
   */
  addClient(res) {
    this.clients.add(res);
    return () => this.clients.delete(res);
  }

  /** Number of currently connected clients. */
  get size() {
    return this.clients.size;
  }

  /**
   * Send a named event with a JSON payload to all connected clients.
   */
  broadcast(event, data) {
    const payload = `event: ${event}\n` + `data: ${JSON.stringify(data)}\n\n`;
    for (const res of this.clients) {
      res.write(payload);
    }
  }
}

export const broadcaster = new Broadcaster();
