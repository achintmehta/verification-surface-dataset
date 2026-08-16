/**
 * GET /api/stream
 * Server-Sent Events endpoint. Keeps the connection alive and lets the
 * broadcast() helper push events to all connected clients.
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

  // Send an initial "connected" comment to confirm the stream is open
  res.write(': connected\n\n');

  // Keep-alive ping every 25 seconds to prevent proxy timeouts
  const keepAlive = setInterval(() => {
    try {
      res.write(': ping\n\n');
    } catch {
      clearInterval(keepAlive);
    }
  }, 25_000);

  const remove = addClient(res);

  req.on('close', () => {
    clearInterval(keepAlive);
    remove();
  });
});

export default router;
