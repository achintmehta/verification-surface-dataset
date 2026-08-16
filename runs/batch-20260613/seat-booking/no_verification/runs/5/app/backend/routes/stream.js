import { Router } from 'express';
import { addClient, removeClient, clientCount } from '../sse.js';

const router = Router();

/**
 * GET /api/stream
 * Server-Sent Events endpoint.
 * Clients connect here and receive seat-update events whenever any seat
 * transitions between available / held / booked.
 */
router.get('/', (req, res) => {
  // SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // disable nginx buffering if present
  res.flushHeaders();

  // Send an initial comment to establish the connection
  res.write(': connected\n\n');

  // Register this client
  addClient(res);
  console.log(`[SSE] Client connected. Total: ${clientCount()}`);

  // Send a heartbeat every 15 s to keep the connection alive through proxies
  const heartbeat = setInterval(() => {
    try {
      res.write(': heartbeat\n\n');
    } catch {
      clearInterval(heartbeat);
    }
  }, 15_000);

  // Clean up when the client disconnects
  req.on('close', () => {
    clearInterval(heartbeat);
    removeClient(res);
    console.log(`[SSE] Client disconnected. Total: ${clientCount()}`);
  });
});

export default router;
