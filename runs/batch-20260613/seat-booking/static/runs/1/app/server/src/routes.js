/**
 * Express route definitions.
 */

import { Router } from 'express';
import { getAllSeats, createHold, confirmHold, releaseHold } from './seats.js';
import { sseHandler } from './sse.js';

const router = Router();

// ---------------------------------------------------------------------------
// GET /api/seats  – full seat map with effective statuses
// ---------------------------------------------------------------------------
router.get('/seats', async (_req, res) => {
  try {
    const seats = await getAllSeats();
    res.json({ seats });
  } catch (err) {
    console.error('[GET /seats]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------------------
// POST /api/holds  – place a hold on one or more seats
// ---------------------------------------------------------------------------
router.post('/holds', async (req, res) => {
  const { seatIds, sessionId } = req.body ?? {};

  if (!Array.isArray(seatIds) || seatIds.length === 0) {
    return res.status(400).json({ error: 'seatIds must be a non-empty array' });
  }
  if (typeof sessionId !== 'string' || !sessionId.trim()) {
    return res.status(400).json({ error: 'sessionId is required' });
  }

  try {
    const result = await createHold(seatIds, sessionId.trim());
    res.status(201).json(result);
  } catch (err) {
    const status = err.status ?? 500;
    const body = { error: err.message };
    if (err.conflictingSeats) body.conflictingSeats = err.conflictingSeats;
    res.status(status).json(body);
  }
});

// ---------------------------------------------------------------------------
// POST /api/holds/:holdId/confirm  – confirm a hold → book seats
// ---------------------------------------------------------------------------
router.post('/holds/:holdId/confirm', async (req, res) => {
  const { holdId } = req.params;
  const { sessionId } = req.body ?? {};

  if (typeof sessionId !== 'string' || !sessionId.trim()) {
    return res.status(400).json({ error: 'sessionId is required' });
  }

  try {
    const result = await confirmHold(holdId, sessionId.trim());
    res.json(result);
  } catch (err) {
    const status = err.status ?? 500;
    res.status(status).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// DELETE /api/holds/:holdId  – release a hold early
// ---------------------------------------------------------------------------
router.delete('/holds/:holdId', async (req, res) => {
  const { holdId } = req.params;
  const { sessionId } = req.body ?? {};

  try {
    const result = await releaseHold(holdId, sessionId ?? null);
    res.json(result);
  } catch (err) {
    const status = err.status ?? 500;
    res.status(status).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// GET /api/stream  – SSE endpoint
// ---------------------------------------------------------------------------
router.get('/stream', sseHandler);

export default router;
