import { Router } from 'express';
import { addClient, removeClient } from '../sse.js';

const router = Router();

/**
 * GET /api/stream
 * Opens a persistent SSE connection.  The client will receive a `connected`
 * event immediately and then `new-message` events whenever a message is posted.
 */
router.get('/', (req, res) => {
  // Set the required SSE headers.
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // Disable Nginx buffering if present.
  res.flushHeaders();

  // Send an initial event so the client knows the stream is live.
  res.write('event: connected\ndata: {"status":"ok"}\n\n');

  // Register this response in the active-clients pool.
  addClient(res);

  // Keep the connection alive with a periodic comment (prevents proxy timeouts).
  const heartbeat = setInterval(() => {
    res.write(': heartbeat\n\n');
  }, 25_000);

  // Clean up when the client disconnects.
  req.on('close', () => {
    clearInterval(heartbeat);
    removeClient(res);
  });
});

export default router;
