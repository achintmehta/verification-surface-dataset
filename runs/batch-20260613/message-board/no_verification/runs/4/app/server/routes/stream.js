import { Router } from 'express';
import { addClient, removeClient } from '../sseManager.js';

const router = Router();

/**
 * GET /api/stream
 *
 * Upgrades the HTTP connection to a persistent Server-Sent Events stream.
 * The client should use the native EventSource API to connect here.
 *
 * On connection we immediately send a "connected" event so the client
 * knows the stream is live.  Thereafter the server pushes "new-message"
 * events whenever a message is posted via POST /api/messages.
 */
router.get('/', (req, res) => {
  // --- SSE headers ---
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  // Disable response buffering in Express / Node so events are flushed
  // to the client immediately.
  res.flushHeaders();

  // Send an initial "connected" event so the client can confirm the
  // stream is working before any messages arrive.
  res.write('event: connected\ndata: {"status":"ok"}\n\n');

  // Register this response object so broadcast() can reach it.
  addClient(res);

  // Keep the connection alive with a periodic comment line every 25 s.
  // This prevents proxies and load-balancers from closing idle connections.
  const heartbeat = setInterval(() => {
    res.write(': heartbeat\n\n');
  }, 25_000);

  // Clean up when the client disconnects (tab closed, navigation, etc.).
  req.on('close', () => {
    clearInterval(heartbeat);
    removeClient(res);
  });
});

export default router;
