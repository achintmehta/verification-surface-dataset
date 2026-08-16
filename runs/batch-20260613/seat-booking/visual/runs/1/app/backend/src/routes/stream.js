/**
 * routes/stream.js – GET /api/stream
 *
 * Server-Sent Events endpoint.  Each connected client receives every seat
 * status transition (held / booked / released) in real time.
 */

import { Router } from 'express';
import { addClient, clientCount } from '../sse.js';

const router = Router();

router.get('/', (req, res) => {
  // SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // disable nginx buffering if present
  res.flushHeaders();

  // Send an initial "connected" event so the client knows the stream is live
  res.write(`event: connected\ndata: ${JSON.stringify({ clientCount: clientCount() + 1 })}\n\n`);

  // Register this client
  const unsubscribe = addClient(res);

  // Keep-alive ping every 20 s to prevent proxy timeouts
  const ping = setInterval(() => {
    try {
      res.write(': ping\n\n');
    } catch {
      clearInterval(ping);
    }
  }, 20_000);

  // Clean up when the client disconnects
  req.on('close', () => {
    clearInterval(ping);
    unsubscribe();
  });
});

export default router;
