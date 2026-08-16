/**
 * GET /api/stream
 *
 * Server-Sent Events endpoint. Keeps the connection open and pushes
 * seat-status events via the broadcast() function in sse.js.
 */

import { Router } from 'express';
import { addClient, removeClient } from '../sse.js';

const router = Router();

router.get('/', (req, res) => {
  // Set SSE headers.
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // Disable nginx buffering if present.
  res.flushHeaders();

  // Send an initial "connected" comment to confirm the stream is live.
  res.write(': connected\n\n');

  // Register this client.
  addClient(res);

  // Remove on disconnect.
  req.on('close', () => {
    removeClient(res);
  });
});

export default router;
