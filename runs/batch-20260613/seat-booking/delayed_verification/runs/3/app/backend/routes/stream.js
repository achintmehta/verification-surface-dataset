import { Router } from 'express';
import { addClient, removeClient } from '../sse.js';

const router = Router();

/**
 * GET /api/stream
 * Establishes a Server-Sent Events connection.
 * The client receives named events:
 *   - seats:held     { seatIds, holdId, expiresAt, sessionId }
 *   - seats:booked   { seatIds, holdId, sessionId }
 *   - seats:released { seatIds }
 */
router.get('/', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // disable nginx buffering if present
  res.flushHeaders();

  // Send an initial comment to confirm the connection
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
