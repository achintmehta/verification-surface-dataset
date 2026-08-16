/**
 * Board routes:
 *   GET  /api/board          – full board state
 *   GET  /api/stream         – SSE stream
 *   POST /api/cards          – create a card
 *   PATCH /api/cards/:id/move – move / reorder a card
 */

import { Router } from 'express';
import { randomUUID } from 'crypto';
import { getBoardState, createCard, moveCard } from '../db.js';
import { addClient, broadcast } from '../sse.js';

const router = Router();

/* ------------------------------------------------------------------ */
/*  GET /api/board                                                      */
/* ------------------------------------------------------------------ */
router.get('/board', async (_req, res) => {
  try {
    const board = await getBoardState();
    res.json(board);
  } catch (err) {
    console.error('[GET /api/board]', err);
    res.status(500).json({ error: 'Failed to load board state.' });
  }
});

/* ------------------------------------------------------------------ */
/*  GET /api/stream  (SSE)                                              */
/* ------------------------------------------------------------------ */
router.get('/stream', (req, res) => {
  addClient(req, res);
});

/* ------------------------------------------------------------------ */
/*  POST /api/cards                                                     */
/* ------------------------------------------------------------------ */
router.post('/cards', async (req, res) => {
  const { columnId, text } = req.body ?? {};

  if (!columnId || typeof columnId !== 'string') {
    return res.status(400).json({ error: '`columnId` is required.' });
  }
  if (!text || typeof text !== 'string' || !text.trim()) {
    return res.status(400).json({ error: '`text` is required.' });
  }

  try {
    const id = randomUUID();
    const card = await createCard(id, columnId, text.trim());

    // Broadcast to all SSE clients.
    broadcast('card:created', { card });

    res.status(201).json({ card });
  } catch (err) {
    console.error('[POST /api/cards]', err);
    res.status(500).json({ error: 'Failed to create card.' });
  }
});

/* ------------------------------------------------------------------ */
/*  PATCH /api/cards/:id/move                                           */
/* ------------------------------------------------------------------ */
router.patch('/cards/:id/move', async (req, res) => {
  const { id } = req.params;
  const { columnId, beforeId = null, afterId = null } = req.body ?? {};

  if (!columnId || typeof columnId !== 'string') {
    return res.status(400).json({ error: '`columnId` is required.' });
  }

  try {
    const { card, renormalized, columnCards } = await moveCard(
      id,
      columnId,
      beforeId,
      afterId
    );

    if (!card) {
      return res.status(404).json({ error: 'Card not found.' });
    }

    if (renormalized && columnCards) {
      // Broadcast the full renormalised column so every client can
      // replace its local ordering with the canonical one.
      broadcast('column:reordered', { columnId, cards: columnCards });
    } else {
      broadcast('card:moved', { card });
    }

    res.json({ card });
  } catch (err) {
    console.error('[PATCH /api/cards/:id/move]', err);
    res.status(500).json({ error: 'Failed to move card.' });
  }
});

export default router;
