/**
 * routes/stream.js
 * Express router handling:
 *   GET /api/stream  — opens a persistent SSE connection with the client
 *
 * Protocol:
 *   - Sets the required SSE headers (Content-Type: text/event-stream, etc.)
 *   - Sends an initial "connected" event so the client knows the stream is live
 *   - Keeps the connection alive with a periodic comment ping every 25 seconds
 *   - Cleans up when the client disconnects
 */

import { Router } from 'express';
import { addClient, removeClient } from '../sseClients.js';

const router = Router();

const PING_INTERVAL_MS = 25_000;

router.get('/', (req, res) => {
  // --- SSE headers -----------------------------------------------------------
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  // Disable response buffering in Express / Node so events are flushed immediately.
  res.flushHeaders();

  // Register this response object so broadcasts can reach it.
  addClient(res);

  // Send an initial event to confirm the stream is open.
  res.write('event: connected\ndata: {"status":"ok"}\n\n');

  // Keep-alive ping: SSE comments (lines starting with ":") are ignored by
  // EventSource but prevent proxies / load-balancers from closing idle connections.
  const pingTimer = setInterval(() => {
    res.write(': ping\n\n');
  }, PING_INTERVAL_MS);

  // Clean up when the client closes the connection.
  req.on('close', () => {
    clearInterval(pingTimer);
    removeClient(res);
  });
});

export default router;
