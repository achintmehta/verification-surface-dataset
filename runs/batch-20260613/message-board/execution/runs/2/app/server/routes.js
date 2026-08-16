import { Router } from 'express';
import { getMessages, insertMessage } from './db.js';
import { addClient, broadcast } from './sse.js';

const router = Router();

/* ------------------------------------------------------------------ */
/*  GET /api/messages  – return full message history                   */
/* ------------------------------------------------------------------ */
router.get('/messages', async (_req, res) => {
  try {
    const messages = await getMessages();
    res.json(messages);
  } catch (err) {
    console.error('[routes] GET /messages error:', err);
    res.status(500).json({ error: 'Failed to fetch messages.' });
  }
});

/* ------------------------------------------------------------------ */
/*  POST /api/messages  – insert a new message & broadcast via SSE     */
/* ------------------------------------------------------------------ */
router.post('/messages', async (req, res) => {
  const text = (req.body?.text ?? '').trim();

  if (!text) {
    return res.status(400).json({ error: 'Message text is required.' });
  }

  if (text.length > 2000) {
    return res.status(400).json({ error: 'Message text must be 2 000 characters or fewer.' });
  }

  try {
    const message = await insertMessage(text);
    // Push the new message to every connected SSE client
    broadcast('new-message', message);
    res.status(201).json(message);
  } catch (err) {
    console.error('[routes] POST /messages error:', err);
    res.status(500).json({ error: 'Failed to save message.' });
  }
});

/* ------------------------------------------------------------------ */
/*  GET /api/stream  – SSE endpoint                                    */
/* ------------------------------------------------------------------ */
router.get('/stream', (req, res) => {
  addClient(req, res);
});

export default router;
