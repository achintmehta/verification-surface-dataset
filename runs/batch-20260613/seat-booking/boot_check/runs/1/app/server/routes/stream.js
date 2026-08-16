import { Router } from 'express';
import { addClient, removeClient } from '../sse.js';

const router = Router();

/**
 * GET /api/stream
 * Server-Sent Events endpoint.
 * Clients connect here and receive seat-update events in real time.
 */
router.get('/', (req, res) => {
  // SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // disable nginx buffering if present
  res.flushHeaders();

  // Send an initial comment to establish the connection
  res.write(': connected\n\n');

  // Keep-alive ping every 20 seconds
  const keepAlive = setInterval(() => {
    try {
      res.write(': ping\n\n');
    } catch {
      clearInterval(keepAlive);
    }
  }, 20_000);

  addClient(res);

  req.on('close', () => {
    clearInterval(keepAlive);
    removeClient(res);
  });
});

export default router;
