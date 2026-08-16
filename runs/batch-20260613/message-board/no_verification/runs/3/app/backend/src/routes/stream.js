/**
 * routes/stream.js
 * Express router that handles:
 *   GET /api/stream  – opens a persistent SSE connection with the client
 *
 * The connection is kept alive with periodic heartbeat comments so that
 * proxies and load-balancers do not time it out.
 */

import { Router } from 'express';
import { addClient, removeClient } from '../sseManager.js';

const router = Router();

const HEARTBEAT_INTERVAL_MS = 25_000; // 25 seconds

/* ------------------------------------------------------------------ */
/* GET /api/stream                                                      */
/* ------------------------------------------------------------------ */
router.get('/', (req, res) => {
  // Set the required SSE headers.
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  // Disable response buffering so events are flushed immediately.
  res.flushHeaders();

  // Send an initial "connected" comment so the client knows the stream is live.
  res.write(': connected\n\n');

  // Register this response object so it receives future broadcasts.
  addClient(res);

  // Send a periodic heartbeat comment to keep the connection alive through
  // proxies that would otherwise close idle connections.
  const heartbeat = setInterval(() => {
    try {
      res.write(': heartbeat\n\n');
    } catch {
      clearInterval(heartbeat);
    }
  }, HEARTBEAT_INTERVAL_MS);

  // Clean up when the client disconnects (tab closed, navigation, etc.).
  req.on('close', () => {
    clearInterval(heartbeat);
    removeClient(res);
  });
});

export default router;
