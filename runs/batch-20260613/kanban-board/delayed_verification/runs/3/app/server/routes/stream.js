/**
 * GET /api/stream
 *
 * Server-Sent Events endpoint.  Each connecting client receives:
 *   - An immediate `connected` event with the current client count.
 *   - Subsequent `card:created`, `card:moved`, and `column:reordered`
 *     events broadcast by mutation handlers.
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

  // Register this client
  addClient(res);

  // Send an initial heartbeat so the client knows the stream is live
  res.write(
    `event: connected\ndata: ${JSON.stringify({ clients: clientCount() })}\n\n`
  );

  // Keep-alive ping every 25 seconds to prevent proxy timeouts
  const keepAlive = setInterval(() => {
    try {
      res.write(': ping\n\n');
    } catch {
      clearInterval(keepAlive);
    }
  }, 25_000);

  req.on('close', () => clearInterval(keepAlive));
});

export default router;
