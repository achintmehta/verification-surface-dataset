/**
 * GET /api/stream
 * Server-Sent Events endpoint.
 * Keeps the connection alive and broadcasts seat status transitions.
 */
import { Router } from 'express';
import { addClient, removeClient, clientCount } from '../sse.js';

const router = Router();

router.get('/', (req, res) => {
  // SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // disable nginx buffering if present
  res.flushHeaders();

  // Send an initial "connected" event
  res.write(`event: connected\ndata: ${JSON.stringify({ message: 'SSE connected', clients: clientCount() + 1 })}\n\n`);

  addClient(res);
  console.log(`SSE client connected. Total: ${clientCount()}`);

  // Keep-alive ping every 20 seconds
  const keepAlive = setInterval(() => {
    try {
      res.write(': ping\n\n');
    } catch {
      clearInterval(keepAlive);
    }
  }, 20_000);

  req.on('close', () => {
    clearInterval(keepAlive);
    removeClient(res);
    console.log(`SSE client disconnected. Total: ${clientCount()}`);
  });
});

export default router;
