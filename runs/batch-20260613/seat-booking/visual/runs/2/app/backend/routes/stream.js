import { Router } from 'express';
import { addClient, removeClient } from '../sse.js';

const router = Router();

/**
 * GET /api/stream
 * Server-Sent Events endpoint. Keeps the connection open and pushes
 * seat status transitions to all connected clients.
 */
router.get('/', (req, res) => {
  // Set SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // Disable nginx buffering if present
  res.flushHeaders();

  // Send an initial "connected" event
  res.write('event: connected\ndata: {"message":"SSE connection established"}\n\n');

  // Register this client
  addClient(res);

  // Send a heartbeat every 15 seconds to keep the connection alive
  const heartbeat = setInterval(() => {
    try {
      res.write(': heartbeat\n\n');
    } catch (_) {
      clearInterval(heartbeat);
    }
  }, 15000);

  // Clean up on disconnect
  req.on('close', () => {
    clearInterval(heartbeat);
    removeClient(res);
    console.log('[SSE] Client disconnected');
  });

  req.on('error', () => {
    clearInterval(heartbeat);
    removeClient(res);
  });
});

export default router;
