/**
 * GET /api/stream
 * Server-Sent Events endpoint.  Clients connect here and receive
 * real-time seat-status updates whenever any seat changes state.
 */
import { Router } from 'express';
import { addClient, removeClient } from '../sse.js';

const router = Router();

router.get('/', (req, res) => {
  // Set SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // disable nginx buffering if present
  res.flushHeaders();

  // Send an initial "connected" comment to establish the stream
  res.write(': connected\n\n');

  // Register this client
  addClient(res);
  console.log(`SSE client connected. Total clients: ${[...Array(1)].length}`);

  // Heartbeat every 15 s to keep the connection alive through proxies
  const heartbeat = setInterval(() => {
    try {
      res.write(': heartbeat\n\n');
    } catch {
      clearInterval(heartbeat);
    }
  }, 15000);

  // Clean up when the client disconnects
  req.on('close', () => {
    clearInterval(heartbeat);
    removeClient(res);
    console.log('SSE client disconnected.');
  });
});

export default router;
