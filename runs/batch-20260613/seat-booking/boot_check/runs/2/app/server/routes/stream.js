import { Router } from 'express';
import { addClient, removeClient, clientCount } from '../sse.js';

const router = Router();

/**
 * GET /api/stream
 * Server-Sent Events endpoint.
 * Keeps the connection open and fans out seat status events to all clients.
 */
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
  console.log(`[SSE] Client connected. Total: ${clientCount()}`);

  // Heartbeat every 20 s to keep the connection alive through proxies
  const heartbeat = setInterval(() => {
    try {
      res.write(`: heartbeat\n\n`);
    } catch {
      clearInterval(heartbeat);
    }
  }, 20000);

  const cleanup = () => {
    clearInterval(heartbeat);
    removeClient(res);
    console.log(`[SSE] Client disconnected. Total: ${clientCount()}`);
  };

  req.on('close', cleanup);
  req.on('error', cleanup);
});

export default router;
