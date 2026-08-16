import { Router } from 'express';
import { getDb } from './db.js';
import { sseHub } from './sse.js';

export const router = Router();

/**
 * GET /api/messages
 * Fetch the historical messages so a freshly loaded client can render the
 * initial state of the board.
 */
router.get('/messages', async (_req, res, next) => {
  try {
    const db = getDb();
    const result = await db.query(
      'SELECT id, text, created_at FROM messages ORDER BY created_at ASC, id ASC',
    );
    res.json(result.rows);
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/messages
 * Insert a new message into PGLite and broadcast it to every connected SSE
 * client so all boards update instantly.
 */
router.post('/messages', async (req, res, next) => {
  try {
    const text = typeof req.body?.text === 'string' ? req.body.text.trim() : '';

    if (!text) {
      return res.status(400).json({ error: 'Message text is required.' });
    }
    if (text.length > 2000) {
      return res
        .status(400)
        .json({ error: 'Message text must be 2000 characters or fewer.' });
    }

    const db = getDb();
    const result = await db.query(
      'INSERT INTO messages (text) VALUES ($1) RETURNING id, text, created_at',
      [text],
    );
    const message = result.rows[0];

    // Push the new message to every connected client in real time.
    sseHub.broadcast('message', message);

    res.status(201).json(message);
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/stream
 * Open a long-lived Server-Sent Events connection. New messages posted by any
 * client are pushed down this stream as `message` events.
 */
router.get('/stream', (req, res) => {
  sseHub.addClient(req, res);
});

/**
 * GET /api/health
 * Simple health check that also reports the number of active SSE clients.
 */
router.get('/health', (_req, res) => {
  res.json({ status: 'ok', clients: sseHub.size });
});
