import { Router } from 'express';
import { addClient, removeClient } from '../sse.js';

const router = Router();

/**
 * GET /api/stream
 * SSE endpoint. Clients connect here to receive real-time seat status updates.
 */
router.get('/', (req, res) => {
  // Set SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // Disable nginx buffering if present
  res.flushHeaders();

  // Send initial connection confirmation
  res.write(`event: connected\ndata: ${JSON.stringify({ message: 'Connected to seat updates' })}\n\n`);

  // Register this client
  addClient(res);

  // Handle client disconnect
  req.on('close', () => {
    removeClient(res);
  });

  req.on('error', () => {
    removeClient(res);
  });
});

export default router;
