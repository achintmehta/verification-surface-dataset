/**
 * routes/stream.js – GET /api/stream
 *
 * Server-Sent Events endpoint.  Each connecting client receives:
 *   1. An immediate `connected` event with the current client count.
 *   2. Subsequent `seat-update` events broadcast by other parts of the system.
 *
 * The connection is kept alive with a 30-second heartbeat comment.
 */

import { Router } from 'express';
import { addClient, removeClient, clientCount } from '../sse.js';

const router = Router();

router.get('/', (req, res) => {
  // Set SSE headers.
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // disable nginx buffering if present
  res.flushHeaders();

  // Register this client.
  addClient(res);
  console.log(`[SSE] Client connected. Total: ${clientCount()}`);

  // Send an initial confirmation event.
  res.write(
    `event: connected\ndata: ${JSON.stringify({ clients: clientCount() })}\n\n`
  );

  // Heartbeat to prevent proxy timeouts.
  const heartbeat = setInterval(() => {
    try {
      res.write(': heartbeat\n\n');
    } catch {
      clearInterval(heartbeat);
    }
  }, 30_000);

  // Clean up when the client disconnects.
  req.on('close', () => {
    clearInterval(heartbeat);
    removeClient(res);
    console.log(`[SSE] Client disconnected. Total: ${clientCount()}`);
  });
});

export default router;
