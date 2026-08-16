import express from 'express';
import cors from 'cors';
import { randomUUID } from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';
import { getDb } from './db.js';
import { addClient, removeClient, broadcastSeatUpdates } from './sse.js';
import { releaseExpiredHolds, startExpirySweep } from './expiry.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
const PORT = process.env.PORT || 3001;

// TTL for holds in seconds
const HOLD_TTL_SECONDS = 60;

app.use(cors());
app.use(express.json());

// ─── GET /api/seats ──────────────────────────────────────────────────────────
// Returns all seats with their effective status (expired holds → available).
app.get('/api/seats', async (req, res) => {
  try {
    const db = await getDb();

    // Sweep expired holds first, then return seats
    await db.transaction(async (tx) => {
      const released = await releaseExpiredHolds(tx);
      if (released.length > 0) {
        broadcastSeatUpdates(released);
      }
    });

    const result = await db.query(`
      SELECT
        id,
        row_label,
        seat_number,
        CASE
          WHEN status = 'held' AND hold_expires_at <= NOW() THEN 'available'
          ELSE status
        END AS status,
        CASE
          WHEN status = 'held' AND hold_expires_at <= NOW() THEN NULL
          ELSE hold_id
        END AS hold_id,
        CASE
          WHEN status = 'held' AND hold_expires_at <= NOW() THEN NULL
          ELSE hold_expires_at
        END AS hold_expires_at,
        booked_by
      FROM seats
      ORDER BY row_label, seat_number
    `);

    res.json({ seats: result.rows });
  } catch (err) {
    console.error('GET /api/seats error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── POST /api/holds ─────────────────────────────────────────────────────────
// Atomically hold all requested seats for a session.
// Body: { seatIds: string[], sessionId: string }
app.post('/api/holds', async (req, res) => {
  const { seatIds, sessionId } = req.body;

  if (!Array.isArray(seatIds) || seatIds.length === 0) {
    return res.status(400).json({ error: 'seatIds must be a non-empty array' });
  }
  if (!sessionId || typeof sessionId !== 'string') {
    return res.status(400).json({ error: 'sessionId is required' });
  }

  const db = await getDb();
  const holdId = randomUUID();
  const expiresAt = new Date(Date.now() + HOLD_TTL_SECONDS * 1000).toISOString();

  try {
    let conflictingSeats = [];
    let heldSeats = [];

    await db.transaction(async (tx) => {
      // 1. Release any expired holds first
      const released = await releaseExpiredHolds(tx);
      if (released.length > 0) {
        broadcastSeatUpdates(released);
      }

      // 2. Lock and check all requested seats atomically
      // Use SELECT ... FOR UPDATE to prevent concurrent modifications
      const seatCheck = await tx.query(`
        SELECT id, status, hold_expires_at
        FROM seats
        WHERE id = ANY($1::text[])
        FOR UPDATE
      `, [seatIds]);

      // Verify all requested seats exist
      if (seatCheck.rows.length !== seatIds.length) {
        const foundIds = new Set(seatCheck.rows.map(r => r.id));
        const missing = seatIds.filter(id => !foundIds.has(id));
        throw { status: 400, error: 'Unknown seat ids', details: missing };
      }

      // Find unavailable seats (held or booked)
      conflictingSeats = seatCheck.rows
        .filter(r => {
          if (r.status === 'booked') return true;
          if (r.status === 'held') {
            // Double-check expiry (should already be released above, but be safe)
            if (r.hold_expires_at && new Date(r.hold_expires_at) <= new Date()) return false;
            return true;
          }
          return false;
        })
        .map(r => r.id);

      if (conflictingSeats.length > 0) {
        throw { status: 409, error: 'Seats unavailable', conflictingSeats };
      }

      // 3. Create the hold record
      await tx.query(`
        INSERT INTO holds (id, session_id, expires_at, confirmed)
        VALUES ($1, $2, $3, FALSE)
      `, [holdId, sessionId, expiresAt]);

      // 4. Atomically mark all seats as held
      const updateResult = await tx.query(`
        UPDATE seats
        SET status = 'held',
            hold_id = $1,
            hold_expires_at = $2
        WHERE id = ANY($3::text[])
          AND status = 'available'
        RETURNING id, status, hold_id, hold_expires_at
      `, [holdId, expiresAt, seatIds]);

      // If we didn't update all seats, a race occurred
      if (updateResult.rows.length !== seatIds.length) {
        const updatedIds = new Set(updateResult.rows.map(r => r.id));
        conflictingSeats = seatIds.filter(id => !updatedIds.has(id));
        throw { status: 409, error: 'Seats unavailable (race)', conflictingSeats };
      }

      heldSeats = updateResult.rows;
    });

    // Broadcast the held seats
    broadcastSeatUpdates(heldSeats.map(s => ({
      id: s.id,
      status: s.status,
      hold_id: s.hold_id,
      hold_expires_at: s.hold_expires_at,
      booked_by: null
    })));

    res.status(201).json({
      hold: {
        id: holdId,
        sessionId,
        seatIds,
        expiresAt,
        ttlSeconds: HOLD_TTL_SECONDS
      }
    });
  } catch (err) {
    if (err.status) {
      return res.status(err.status).json({
        error: err.error,
        conflictingSeats: err.conflictingSeats || [],
        details: err.details
      });
    }
    console.error('POST /api/holds error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── POST /api/holds/:holdId/confirm ─────────────────────────────────────────
// Confirm a hold, booking the seats permanently.
// Idempotent: confirming an already-confirmed hold returns the same result.
app.post('/api/holds/:holdId/confirm', async (req, res) => {
  const { holdId } = req.params;
  const { sessionId } = req.body;

  if (!sessionId || typeof sessionId !== 'string') {
    return res.status(400).json({ error: 'sessionId is required' });
  }

  const db = await getDb();

  try {
    let bookedSeats = [];
    let alreadyConfirmed = false;

    await db.transaction(async (tx) => {
      // 1. Release expired holds (but not this one yet — we check it explicitly)
      const released = await releaseExpiredHolds(tx);
      if (released.length > 0) {
        broadcastSeatUpdates(released);
      }

      // 2. Fetch the hold with a lock
      const holdResult = await tx.query(`
        SELECT id, session_id, expires_at, confirmed
        FROM holds
        WHERE id = $1
        FOR UPDATE
      `, [holdId]);

      if (holdResult.rows.length === 0) {
        throw { status: 404, error: 'Hold not found or already expired' };
      }

      const hold = holdResult.rows[0];

      // 3. Verify ownership
      if (hold.session_id !== sessionId) {
        throw { status: 403, error: 'Hold does not belong to this session' };
      }

      // 4. Idempotency: already confirmed
      if (hold.confirmed) {
        alreadyConfirmed = true;
        const alreadyBooked = await tx.query(`
          SELECT id, status, booked_by FROM seats WHERE hold_id = $1
        `, [holdId]);
        bookedSeats = alreadyBooked.rows;
        return;
      }

      // 5. Check expiry
      if (new Date(hold.expires_at) <= new Date()) {
        throw { status: 410, error: 'Hold has expired' };
      }

      // 6. Lock and verify seats still belong to this hold
      const seatsResult = await tx.query(`
        SELECT id, status, hold_id
        FROM seats
        WHERE hold_id = $1
        FOR UPDATE
      `, [holdId]);

      if (seatsResult.rows.length === 0) {
        throw { status: 409, error: 'No seats found for this hold' };
      }

      const invalidSeats = seatsResult.rows.filter(
        s => s.status !== 'held' || s.hold_id !== holdId
      );
      if (invalidSeats.length > 0) {
        throw { status: 409, error: 'Some seats are no longer held by this hold' };
      }

      // 7. Book the seats
      const bookResult = await tx.query(`
        UPDATE seats
        SET status = 'booked',
            hold_id = $1,
            hold_expires_at = NULL,
            booked_by = $2
        WHERE hold_id = $1
          AND status = 'held'
        RETURNING id, status, hold_id, booked_by
      `, [holdId, sessionId]);

      // 8. Mark hold as confirmed
      await tx.query(`
        UPDATE holds SET confirmed = TRUE WHERE id = $1
      `, [holdId]);

      bookedSeats = bookResult.rows;
    });

    // Broadcast booked seats
    if (!alreadyConfirmed) {
      broadcastSeatUpdates(bookedSeats.map(s => ({
        id: s.id,
        status: 'booked',
        hold_id: s.hold_id,
        booked_by: s.booked_by
      })));
    }

    res.json({
      booking: {
        holdId,
        sessionId,
        seatIds: bookedSeats.map(s => s.id),
        alreadyConfirmed
      }
    });
  } catch (err) {
    if (err.status) {
      return res.status(err.status).json({ error: err.error });
    }
    console.error(`POST /api/holds/${holdId}/confirm error:`, err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── DELETE /api/holds/:holdId ────────────────────────────────────────────────
// Release a hold early, returning seats to available.
app.delete('/api/holds/:holdId', async (req, res) => {
  const { holdId } = req.params;
  const { sessionId } = req.body;

  if (!sessionId || typeof sessionId !== 'string') {
    return res.status(400).json({ error: 'sessionId is required' });
  }

  const db = await getDb();

  try {
    let releasedSeats = [];

    await db.transaction(async (tx) => {
      // Verify hold ownership
      const holdResult = await tx.query(`
        SELECT id, session_id, confirmed FROM holds WHERE id = $1 FOR UPDATE
      `, [holdId]);

      if (holdResult.rows.length === 0) {
        throw { status: 404, error: 'Hold not found' };
      }

      const hold = holdResult.rows[0];

      if (hold.session_id !== sessionId) {
        throw { status: 403, error: 'Hold does not belong to this session' };
      }

      if (hold.confirmed) {
        throw { status: 409, error: 'Cannot release a confirmed hold' };
      }

      // Release the seats
      const releaseResult = await tx.query(`
        UPDATE seats
        SET status = 'available',
            hold_id = NULL,
            hold_expires_at = NULL
        WHERE hold_id = $1
          AND status = 'held'
        RETURNING id
      `, [holdId]);

      // Delete the hold
      await tx.query(`DELETE FROM holds WHERE id = $1`, [holdId]);

      releasedSeats = releaseResult.rows.map(r => ({
        id: r.id,
        status: 'available',
        hold_id: null,
        booked_by: null
      }));
    });

    broadcastSeatUpdates(releasedSeats);

    res.json({ released: releasedSeats.map(s => s.id) });
  } catch (err) {
    if (err.status) {
      return res.status(err.status).json({ error: err.error });
    }
    console.error(`DELETE /api/holds/${holdId} error:`, err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── GET /api/stream ─────────────────────────────────────────────────────────
// SSE endpoint for real-time seat status updates.
app.get('/api/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  // Send a heartbeat comment immediately
  res.write(': connected\n\n');

  addClient(res);

  // Heartbeat every 15 seconds to keep connection alive
  const heartbeat = setInterval(() => {
    try {
      res.write(': heartbeat\n\n');
    } catch {
      clearInterval(heartbeat);
    }
  }, 15000);

  req.on('close', () => {
    clearInterval(heartbeat);
    removeClient(res);
  });
});

// ─── GET /api/health ─────────────────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ─── Serve frontend static files ──────────────────────────────────────────────
const appRoot = path.join(__dirname, '..');
const frontendDist = path.join(__dirname, '..', 'frontend', 'dist');

// Serve preview.html and other root-level files
app.use(express.static(appRoot, { index: false }));
// Serve built frontend assets
app.use(express.static(frontendDist));
// SPA fallback
app.get('*', (req, res) => {
  res.sendFile(path.join(frontendDist, 'index.html'));
});

// ─── Start server ─────────────────────────────────────────────────────────────
async function main() {
  try {
    const db = await getDb();
    console.log('Database initialized.');

    // Start periodic expiry sweep every 5 seconds
    startExpirySweep(db, 5000);

    app.listen(PORT, () => {
      console.log(`Backend server running on http://localhost:${PORT}`);
    });
  } catch (err) {
    console.error('Failed to start server:', err);
    process.exit(1);
  }
}

main();
