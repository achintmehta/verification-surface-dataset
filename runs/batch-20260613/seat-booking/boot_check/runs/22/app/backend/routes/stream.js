import { Router } from 'express';

// Store all active SSE connections
const clients = new Set();

export function createStreamRoutes() {
  const router = Router();

  router.get('/stream', (req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });

    // Send initial connection message
    res.write(`data: ${JSON.stringify({ type: 'connected' })}\n\n`);

    clients.add(res);

    // Send heartbeat every 15s to keep connection alive
    const heartbeat = setInterval(() => {
      res.write(': heartbeat\n\n');
    }, 15000);

    req.on('close', () => {
      clearInterval(heartbeat);
      clients.delete(res);
    });
  });

  return router;
}

/**
 * Broadcast seat changes to all connected SSE clients
 * @param {Array} seats - Array of seat objects with updated status
 */
export function broadcastSeatChanges(seats) {
  if (!seats || seats.length === 0) return;

  const data = JSON.stringify({
    type: 'seat-update',
    seats: seats,
    timestamp: new Date().toISOString(),
  });

  const message = `data: ${data}\n\n`;

  for (const client of clients) {
    try {
      client.write(message);
    } catch (err) {
      clients.delete(client);
    }
  }
}
