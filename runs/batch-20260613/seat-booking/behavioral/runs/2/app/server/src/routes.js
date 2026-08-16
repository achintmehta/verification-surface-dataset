import { Router } from 'express';
import { getAllSeats, createHold, confirmHold, releaseHold } from './seats.js';
import { addClient, removeClient } from './sse.js';

export function createRouter(db) {
  const router = Router();

  // ─── GET /api/seats ──────────────────────────────────────────────────────────
  router.get('/seats', async (req, res) => {
    try {
      const seats = await getAllSeats(db);
      res.json({ seats });
    } catch (err) {
      console.error('[GET /seats]', err);
      res.status(500).json({ error: 'Failed to fetch seats' });
    }
  });

  // ─── POST /api/holds ─────────────────────────────────────────────────────────
  router.post('/holds', async (req, res) => {
    const { seatIds, sessionId } = req.body ?? {};

    if (!sessionId || typeof sessionId !== 'string' || !sessionId.trim()) {
      return res.status(400).json({ error: 'sessionId is required' });
    }
    if (!Array.isArray(seatIds) || seatIds.length === 0) {
      return res.status(400).json({ error: 'seatIds must be a non-empty array' });
    }

    try {
      const { hold, seats } = await createHold(db, seatIds, sessionId.trim());
      res.status(201).json({ hold, seats });
    } catch (err) {
      if (err.conflict) {
        return res.status(409).json({
          error: 'One or more seats are unavailable',
          conflictingSeats: err.conflictingSeats,
        });
      }
      if (err.notFound) {
        return res.status(404).json({
          error: err.message,
          missingIds: err.missingIds,
        });
      }
      console.error('[POST /holds]', err);
      res.status(500).json({ error: 'Failed to create hold' });
    }
  });

  // ─── POST /api/holds/:holdId/confirm ─────────────────────────────────────────
  router.post('/holds/:holdId/confirm', async (req, res) => {
    const { holdId } = req.params;
    const { sessionId } = req.body ?? {};

    if (!sessionId || typeof sessionId !== 'string' || !sessionId.trim()) {
      return res.status(400).json({ error: 'sessionId is required' });
    }

    try {
      const result = await confirmHold(db, holdId, sessionId.trim());
      res.json(result);
    } catch (err) {
      if (err.notFound) {
        return res.status(404).json({ error: err.message });
      }
      if (err.expired) {
        return res.status(410).json({ error: 'Hold has expired' });
      }
      if (err.forbidden) {
        return res.status(403).json({ error: err.message });
      }
      if (err.conflict) {
        return res.status(409).json({ error: err.message });
      }
      console.error('[POST /holds/:holdId/confirm]', err);
      res.status(500).json({ error: 'Failed to confirm hold' });
    }
  });

  // ─── DELETE /api/holds/:holdId ────────────────────────────────────────────────
  router.delete('/holds/:holdId', async (req, res) => {
    const { holdId } = req.params;
    const { sessionId } = req.body ?? {};

    if (!sessionId || typeof sessionId !== 'string' || !sessionId.trim()) {
      return res.status(400).json({ error: 'sessionId is required' });
    }

    try {
      const result = await releaseHold(db, holdId, sessionId.trim());
      res.json(result);
    } catch (err) {
      if (err.notFound) {
        return res.status(404).json({ error: err.message });
      }
      if (err.forbidden) {
        return res.status(403).json({ error: err.message });
      }
      console.error('[DELETE /holds/:holdId]', err);
      res.status(500).json({ error: 'Failed to release hold' });
    }
  });

  // ─── GET /api/stream (SSE) ────────────────────────────────────────────────────
  router.get('/stream', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no'); // Disable nginx buffering if present
    res.flushHeaders();

    // Send a heartbeat comment immediately so the client knows it's connected
    res.write(': connected\n\n');

    addClient(res);

    // Heartbeat every 15 s to keep the connection alive through proxies
    const heartbeat = setInterval(() => {
      try {
        res.write(': heartbeat\n\n');
      } catch {
        clearInterval(heartbeat);
      }
    }, 15_000);

    req.on('close', () => {
      clearInterval(heartbeat);
      removeClient(res);
    });
  });

  return router;
}
