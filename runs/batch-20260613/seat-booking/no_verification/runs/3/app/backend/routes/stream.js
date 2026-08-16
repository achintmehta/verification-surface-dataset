import { Router } from 'express';
import { addClient } from '../sse.js';

const router = Router();

/**
 * GET /api/stream
 * Server-Sent Events endpoint. Keeps the connection open and pushes
 * seat-status events to the client as they happen.
 */
router.get('/', (req, res) => {
  // SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // disable nginx buffering if present
  res.flushHeaders();

  // Send an initial "connected" event so the client knows the stream is live
  res.write(`event: connected\ndata: ${JSON.stringify({ message: 'SSE connected' })}\n\n`);

  // Register this client
  const cleanup = addClient(res);

  // Keep-alive ping every 20 seconds to prevent proxy timeouts
  const keepAlive = setInterval(() => {
    try {
      res.write(': keep-alive\n\n');
    } catch {
      clearInterval(keepAlive);
    }
  }, 20_000);

  // Clean up when the client disconnects
  req.on('close', () => {
    clearInterval(keepAlive);
    cleanup();
  });
});

export default router;
