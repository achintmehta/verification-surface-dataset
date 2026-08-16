import { Router } from 'express';
import { addClient, removeClient, clientCount } from '../sse.js';

const router = Router();

/**
 * GET /api/stream
 * Server-Sent Events endpoint.
 * Clients connect here to receive real-time seat-status updates.
 */
router.get('/', (req, res) => {
  // Set SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // Disable nginx buffering if present
  res.flushHeaders();

  // Send an initial "connected" event
  res.write(`event: connected\ndata: ${JSON.stringify({ message: 'SSE connected', clients: clientCount() + 1 })}\n\n`);

  // Register this client
  addClient(res);
  console.log(`[SSE] Client connected. Total: ${clientCount()}`);

  // Send a heartbeat every 15 seconds to keep the connection alive
  const heartbeat = setInterval(() => {
    try {
      res.write(`: heartbeat\n\n`);
    } catch {
      clearInterval(heartbeat);
    }
  }, 15000);

  // Clean up on disconnect
  req.on('close', () => {
    clearInterval(heartbeat);
    removeClient(res);
    console.log(`[SSE] Client disconnected. Total: ${clientCount()}`);
  });

  req.on('error', () => {
    clearInterval(heartbeat);
    removeClient(res);
  });
});

export default router;
