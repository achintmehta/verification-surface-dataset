import { Router } from 'express';
import { addClient, removeClient } from '../sse.js';

const router = Router();

/**
 * GET /api/stream
 *
 * Establishes a persistent Server-Sent Events connection with the requesting
 * client.  The connection is kept alive until the client disconnects.
 *
 * Protocol notes:
 *  - Content-Type must be "text/event-stream".
 *  - Cache-Control must be "no-cache" to prevent intermediary caching.
 *  - Connection must be "keep-alive".
 *  - An initial comment ": connected\n\n" is sent immediately so the browser
 *    EventSource knows the stream is live.
 *  - A heartbeat comment is sent every 25 seconds to prevent idle connection
 *    timeouts from proxies / load balancers.
 */
router.get('/', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  // Disable response buffering in Express / Node so events are flushed
  // immediately rather than being held in a write buffer.
  res.flushHeaders();

  // Send an initial comment to confirm the stream is open.
  res.write(': connected\n\n');

  addClient(res);

  // Heartbeat – keeps the TCP connection alive through proxies.
  const heartbeat = setInterval(() => {
    res.write(': heartbeat\n\n');
  }, 25_000);

  // Clean up when the client closes the connection.
  req.on('close', () => {
    clearInterval(heartbeat);
    removeClient(res);
  });
});

export default router;
