import { Router } from 'express';
import { addClient, removeClient } from '../sse.js';

const router = Router();

/**
 * GET /api/stream
 * Establishes a Server-Sent Events connection.
 * The client will receive named events:
 *   seat:held     – a seat was placed on hold
 *   seat:booked   – a seat was confirmed/booked
 *   seat:released – a seat was released (hold expired or deleted)
 */
router.get('/', (req, res) => {
  // SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // disable nginx buffering if present
  res.flushHeaders();

  // Send an initial "connected" comment to flush the headers to the client
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
