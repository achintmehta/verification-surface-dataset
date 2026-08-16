/**
 * routes/stream.js
 * Express router handling:
 *   GET /api/stream  – opens a persistent SSE connection with the client
 *
 * The client receives a `connected` event immediately after the handshake
 * so it can confirm the stream is live before relying on it for updates.
 */

import { Router } from 'express';
import { addClient, removeClient } from '../sseClients.js';

const router = Router();

// ---------------------------------------------------------------------------
// GET /api/stream
// Upgrades the HTTP connection to a long-lived SSE stream.
// ---------------------------------------------------------------------------
router.get('/', (req, res) => {
  // Set the required SSE headers.
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  // Disable response buffering so events are flushed immediately.
  res.flushHeaders();

  // Register this response object so broadcasts reach it.
  addClient(res);

  // Send an initial "connected" event so the client knows the stream is ready.
  res.write('event: connected\ndata: {}\n\n');

  // Keep the connection alive with a periodic comment line every 25 seconds.
  // This prevents proxies and load-balancers from closing idle connections.
  const heartbeat = setInterval(() => {
    res.write(': heartbeat\n\n');
  }, 25_000);

  // Clean up when the client closes the connection (tab closed, navigation, etc.)
  req.on('close', () => {
    clearInterval(heartbeat);
    removeClient(res);
  });
});

export default router;
