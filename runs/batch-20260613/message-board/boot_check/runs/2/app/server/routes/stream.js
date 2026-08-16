import { Router } from 'express';
import { addClient, removeClient } from '../sseClients.js';

const router = Router();

/**
 * GET /api/stream
 *
 * Establishes a persistent Server-Sent Events connection with the client.
 * The client will receive `new-message` events whenever a new message is
 * posted to the board.
 */
router.get('/', (req, res) => {
  // Set the required SSE headers.
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  // Disable response buffering so events are flushed immediately.
  res.flushHeaders();

  // Send an initial "connected" comment to confirm the stream is open.
  // SSE comments (lines starting with `:`) are ignored by EventSource but
  // help flush the connection through any intermediate proxies.
  res.write(': connected\n\n');

  // Register this response object so broadcasts reach it.
  addClient(res);

  // Keep the connection alive with a periodic heartbeat comment every 25 s.
  // This prevents proxies / load-balancers from closing idle connections.
  const heartbeat = setInterval(() => {
    res.write(': heartbeat\n\n');
  }, 25_000);

  // Clean up when the client disconnects (tab closed, navigation, etc.).
  req.on('close', () => {
    clearInterval(heartbeat);
    removeClient(res);
  });
});

export default router;
