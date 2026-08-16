import { Router } from 'express';
import { addClient, removeClient } from '../sseClients.js';

const router = Router();

// ---------------------------------------------------------------------------
// GET /api/stream
// Upgrades the HTTP connection to a persistent SSE stream.
// The client will receive a "connected" event immediately, then "new-message"
// events whenever a new message is posted.
// ---------------------------------------------------------------------------
router.get('/', (req, res) => {
  // Set the required SSE headers.
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  // Disable response buffering so events are flushed immediately.
  res.flushHeaders();

  // Send an initial "connected" event so the client knows the stream is live.
  res.write('event: connected\ndata: {"status":"ok"}\n\n');

  // Register this response object as an active SSE client.
  addClient(res);

  // When the client closes the connection (tab closed, navigation, etc.)
  // remove it from the registry to avoid memory leaks.
  req.on('close', () => {
    removeClient(res);
  });
});

export default router;
