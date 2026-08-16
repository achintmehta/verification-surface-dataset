import { Router } from 'express';
import { addClient } from '../sse.js';

const router = Router();

/**
 * GET /api/stream
 * Establishes a Server-Sent Events connection.
 * The client receives:
 *   - event: card:created  data: <card object>
 *   - event: card:moved    data: <card object>
 *   - event: column:reordered  data: { columnId, cards: [...] }
 */
router.get('/', (req, res) => {
  res.setHeader('Content-Type',  'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection',    'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // disable nginx buffering if present
  res.flushHeaders();

  // Send an initial heartbeat so the client knows the connection is live
  res.write('event: connected\ndata: {}\n\n');

  addClient(res);

  // Keep-alive ping every 25 seconds to prevent proxy timeouts
  const ping = setInterval(() => {
    try {
      res.write(': ping\n\n');
    } catch {
      clearInterval(ping);
    }
  }, 25_000);

  req.on('close', () => clearInterval(ping));
});

export default router;
