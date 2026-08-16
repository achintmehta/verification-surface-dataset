import { Router } from 'express';
import { addClient, removeClient } from '../sseClients.js';

const router = Router();

/**
 * GET /api/stream
 * Opens a persistent Server-Sent Events connection.
 * The client will receive a `connected` event immediately, then
 * `new-message` events whenever a message is posted.
 */
router.get('/', (req, res) => {
  // SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // disable nginx buffering if present
  res.flushHeaders();

  // Send an initial "connected" event so the client knows the stream is live
  res.write('event: connected\ndata: {"status":"ok"}\n\n');

  // Register this client
  addClient(res);

  // Clean up when the client closes the connection
  req.on('close', () => {
    removeClient(res);
  });
});

export default router;
