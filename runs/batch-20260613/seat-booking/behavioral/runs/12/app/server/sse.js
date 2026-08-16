// A tiny Server-Sent Events hub. Every connected client receives every seat
// status transition so all seat maps stay live.
import { randomUUID } from 'node:crypto';

export class SSEHub {
  constructor() {
    /** @type {Map<string, import('http').ServerResponse>} */
    this.clients = new Map();
  }

  /**
   * Register an Express response as an SSE client. Returns a cleanup function.
   */
  addClient(res) {
    const id = randomUUID();
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    // Initial comment to open the stream and prompt some proxies to flush.
    res.write(': connected\n\n');
    this.clients.set(id, res);

    // Heartbeat keeps the connection alive through idle proxies.
    const heartbeat = setInterval(() => {
      try {
        res.write(': ping\n\n');
      } catch {
        this.removeClient(id);
      }
    }, 25000);

    const cleanup = () => {
      clearInterval(heartbeat);
      this.removeClient(id);
    };
    return cleanup;
  }

  removeClient(id) {
    this.clients.delete(id);
  }

  /**
   * Broadcast a named event with a JSON payload to all connected clients.
   */
  broadcast(event, payload) {
    const data = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
    for (const [id, res] of this.clients) {
      try {
        res.write(data);
      } catch {
        this.removeClient(id);
      }
    }
  }

  /**
   * Convenience: broadcast a batch of seat transitions under the `seats` event.
   * @param {Array<object>} seats array of seat snapshots
   * @param {string} reason transition reason: 'held' | 'booked' | 'released'
   */
  broadcastSeats(seats, reason) {
    if (!seats || seats.length === 0) return;
    this.broadcast('seats', { reason, seats, at: new Date().toISOString() });
  }

  get size() {
    return this.clients.size;
  }
}
