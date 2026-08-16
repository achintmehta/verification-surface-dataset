import { Router } from 'express';
import { addClient, clientCount } from '../sse.js';

const router = Router();

/**
 * GET /api/stream
 * Server-Sent Events endpoint. Keeps the connection open and pushes seat
 * status transitions to every connected client.
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

  // Keep-alive ping every 20 seconds
  const ping = setInterval(() => {
    try {
      res.write(`: ping\n\n`);
    } catch {
      clearInterval(ping);
    }
  }, 20_000);

  const remove = addClient(res);
  console.log(`[sse] Client connected (total: ${clientCount()})`);

  req.on('close', () => {
    clearInterval(ping);
    remove();
    console.log(`[sse] Client disconnected (total: ${clientCount()})`);
  });
});

export default router;
