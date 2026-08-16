import { Router } from 'express';
import { addClient, clientCount } from '../sse.js';

const router = Router();

/**
 * GET /api/stream
 * Server-Sent Events endpoint.  Clients connect here and receive named events:
 *   - seats:updated  { seats[] }  – one or more seats changed status
 *   - ping           {}           – keepalive every 15 s
 */
router.get('/', (req, res) => {
  // SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // disable nginx buffering if present
  res.flushHeaders();

  // Send an initial comment so the browser knows the connection is live
  res.write(': connected\n\n');

  const remove = addClient(res);
  console.log(`[sse] Client connected. Total: ${clientCount()}`);

  // Keepalive ping every 15 s
  const ping = setInterval(() => {
    try {
      res.write(`event: ping\ndata: {}\n\n`);
    } catch {
      clearInterval(ping);
    }
  }, 15_000);

  req.on('close', () => {
    clearInterval(ping);
    remove();
    console.log(`[sse] Client disconnected. Total: ${clientCount()}`);
  });
});

export default router;
