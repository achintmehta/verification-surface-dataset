import { Router } from 'express';
import { addClient, removeClient } from '../sseClients.js';

const router = Router();

/**
 * GET /api/stream
 *
 * Establishes a persistent Server-Sent Events connection with the client.
 * The connection is kept alive until the client disconnects.
 *
 * Clients should listen for the custom "message" event to receive new posts.
 */
router.get('/', (req, res) => {
  // Set the required SSE headers.
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  // Disable response buffering so events are flushed immediately.
  res.flushHeaders();

  // Send an initial "connected" event so the client knows the stream is live.
  res.write('event: connected\ndata: {"status":"connected"}\n\n');

  // Register this response object as an active SSE client.
  addClient(res);

  // Keep the connection alive with a periodic comment ping every 25 seconds.
  // This prevents proxies and load balancers from closing idle connections.
  const keepAlive = setInterval(() => {
    res.write(': ping\n\n');
  }, 25_000);

  // Clean up when the client closes the connection.
  req.on('close', () => {
    clearInterval(keepAlive);
    removeClient(res);
  });
});

export default router;
