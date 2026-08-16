/**
 * GET /api/stream
 *
 * Server-Sent Events endpoint. Keeps the connection alive and broadcasts
 * seat-status transitions to all connected clients.
 */

import { Router } from 'express';
import { addClient } from '../sse.js';

const router = Router();

router.get('/', (req, res) => {
  // SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // disable nginx buffering if present
  res.flushHeaders();

  // Send an initial "connected" event so the client knows the stream is live
  res.write('event: connected\ndata: {}\n\n');

  // Register this response for broadcasts
  addClient(res);

  // Keep-alive ping every 20 seconds
  const keepAlive = setInterval(() => {
    try {
      res.write(': ping\n\n');
    } catch {
      clearInterval(keepAlive);
    }
  }, 20_000);

  req.on('close', () => clearInterval(keepAlive));
});

export default router;
