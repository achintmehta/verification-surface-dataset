import express from 'express';
import cors from 'cors';
import { initDb, getDb } from './db.js';
import { expireStaleHolds } from './expiry.js';
import { broadcast } from './sse.js';
import { dbMutex } from './mutex.js';
import seatsRouter from './routes/seats.js';
import holdsRouter from './routes/holds.js';
import streamRouter from './routes/stream.js';

const PORT = process.env.PORT || 3001;

const app = express();

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(cors({ origin: '*' }));
app.use(express.json());

// ── Routes ────────────────────────────────────────────────────────────────────
app.use('/api/seats', seatsRouter);
app.use('/api/holds', holdsRouter);
app.use('/api/stream', streamRouter);

// Health check
app.get('/api/health', (_req, res) => res.json({ status: 'ok' }));

// ── Bootstrap ─────────────────────────────────────────────────────────────────
async function start() {
  try {
    await initDb();

    const db = await getDb();

    // Periodic background sweep: expire stale holds every 10 seconds
    setInterval(async () => {
      try {
        const freed = await dbMutex.run(async () => {
          await db.exec('BEGIN');
          try {
            const freed = await expireStaleHolds(db);
            await db.exec('COMMIT');
            return freed;
          } catch (err) {
            await db.exec('ROLLBACK');
            throw err;
          }
        });

        if (freed.length > 0) {
          broadcast('seats_released', {
            seats: freed.map(s => ({
              id: s.id,
              row_label: s.row_label,
              seat_number: s.seat_number,
              status: 'available',
            })),
          });
          console.log(`[sweep] Released ${freed.length} expired seat(s)`);
        }
      } catch (err) {
        console.error('[sweep] Error during expiry sweep:', err);
      }
    }, 10_000);

    app.listen(PORT, () => {
      console.log(`[server] Listening on http://localhost:${PORT}`);
    });
  } catch (err) {
    console.error('[server] Failed to start:', err);
    process.exit(1);
  }
}

start();
