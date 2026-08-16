import { Router } from 'express';
import { randomUUID } from 'crypto';
import { getBoardState, createCard, moveCard } from './db.js';
import { addClient, broadcast } from './sse.js';

const router = Router();

// ─── GET /api/board ──────────────────────────────────────────────────────────
router.get('/board', async (_req, res) => {
  try {
    const board = await getBoardState();
    res.json(board);
  } catch (err) {
    console.error('[routes] GET /board error:', err);
    res.status(500).json({ error: 'Failed to load board state' });
  }
});

// ─── GET /api/stream ─────────────────────────────────────────────────────────
router.get('/stream', (req, res) => {
  addClient(req, res);
});

// ─── POST /api/cards ─────────────────────────────────────────────────────────
router.post('/cards', async (req, res) => {
  const { columnId, text } = req.body ?? {};

  if (!columnId || typeof text !== 'string' || text.trim() === '') {
    return res.status(400).json({ error: 'columnId and non-empty text are required' });
  }

  try {
    const id = randomUUID();
    const card = await createCard(id, columnId, text.trim());

    // Broadcast to all SSE clients
    broadcast('card:created', { card });

    res.status(201).json({ card });
  } catch (err) {
    console.error('[routes] POST /cards error:', err);
    res.status(500).json({ error: 'Failed to create card' });
  }
});

// ─── PATCH /api/cards/:id/move ───────────────────────────────────────────────
/**
 * Body: { columnId, beforeId?, afterId? }
 *   afterId  = the card immediately ABOVE the drop target (lower position)
 *   beforeId = the card immediately BELOW the drop target (higher position)
 *
 * The server computes the canonical position between afterId and beforeId,
 * persists it atomically, and broadcasts the result.
 */
router.patch('/cards/:id/move', async (req, res) => {
  const { id } = req.params;
  const { columnId, beforeId = null, afterId = null } = req.body ?? {};

  if (!columnId) {
    return res.status(400).json({ error: 'columnId is required' });
  }

  try {
    const { card, renormalized } = await moveCard(id, columnId, beforeId, afterId);

    // Broadcast the canonical card state
    broadcast('card:moved', { card });

    // If the column was renormalized, broadcast the corrected order
    if (renormalized.length > 0) {
      broadcast('column:renormalized', { columnId, positions: renormalized });
    }

    res.json({ card, renormalized });
  } catch (err) {
    console.error('[routes] PATCH /cards/:id/move error:', err);
    res.status(500).json({ error: 'Failed to move card' });
  }
});

export default router;
