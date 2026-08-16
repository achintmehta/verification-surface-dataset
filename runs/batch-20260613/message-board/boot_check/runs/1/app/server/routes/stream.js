import { Router } from 'express';
import { addClient, removeClient } from '../sseClients.js';

const router = Router();

/**
 * GET /api/stream
 *
 * Establishes a persistent Server-Sent Events connection.
 * The client will receive a `connected` event immediately after
 * the handshake, and then a `message` event for every new post.
 */
router.get('/', (req, res) => {
  // --- SSE handshake headers ---
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  // Disable response buffering so chunks are flushed immediately.
  res.flushHeaders();

  // Send an initial heartbeat so the client knows the stream is live.
  res.write('event: connected\ndata: {"status":"ok"}\n\n');

  // Register this response object so broadcasts reach it.
  addClient(res);

  // Keep the connection alive with a periodic comment line (prevents
  // proxies from closing idle connections after ~30 s).
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
