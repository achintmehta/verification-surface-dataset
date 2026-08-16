import { Router } from 'express';
import { addClient, removeClient } from '../sse.js';

const router = Router();

/**
 * GET /api/stream
 * Server-Sent Events endpoint.
 * Keeps the connection open and pushes seat-update events as they occur.
 */
router.get('/', (req, res) => {
  // Set SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // Disable nginx buffering if present
  res.flushHeaders();

  // Send an initial "connected" event so the client knows the stream is live
  res.write('event: connected\ndata: {"status":"connected"}\n\n');

  // Register this client
  addClient(res);

  // Send a heartbeat every 15 s to keep the connection alive through proxies
  const heartbeat = setInterval(() => {
    try {
      res.write(': heartbeat\n\n');
    } catch {
      clearInterval(heartbeat);
    }
  }, 15000);

  // Clean up on disconnect
  req.on('close', () => {
    clearInterval(heartbeat);
    removeClient(res);
  });
});

export default router;
