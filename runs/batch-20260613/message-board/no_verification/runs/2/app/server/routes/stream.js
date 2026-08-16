import { Router } from 'express';
import { addClient, removeClient } from '../sseClients.js';

const router = Router();

// ---------------------------------------------------------------------------
// GET /api/stream
// Upgrade the HTTP connection to a persistent SSE stream.
// ---------------------------------------------------------------------------
router.get('/', (req, res) => {
  // Set the required SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  // Disable response buffering so events are flushed immediately
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  // Send an initial "connected" event so the client knows the stream is live
  res.write('event: connected\ndata: {}\n\n');

  // Register this response as an active SSE client
  addClient(res);

  // Keep the connection alive with a periodic comment (prevents proxy timeouts)
  const heartbeat = setInterval(() => {
    try {
      res.write(': heartbeat\n\n');
    } catch {
      clearInterval(heartbeat);
    }
  }, 25_000);

  // Clean up when the client closes the connection
  req.on('close', () => {
    clearInterval(heartbeat);
    removeClient(res);
  });
});

export default router;
