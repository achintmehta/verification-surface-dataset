import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { initDb } from './db.js';
import { sweepAndBroadcast } from './expiry.js';
import { getDb } from './db.js';
import seatsRouter from './routes/seats.js';
import holdsRouter from './routes/holds.js';
import streamRouter from './routes/stream.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = process.env.PORT || 3001;

const app = express();

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------
app.use(cors({ origin: '*' }));
app.use(express.json());

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------
app.use('/api/seats', seatsRouter);
app.use('/api/holds', holdsRouter);
app.use('/api/stream', streamRouter);

// Health check
app.get('/api/health', (_req, res) => res.json({ status: 'ok' }));

// Serve built frontend in production
const distPath = path.join(__dirname, '..', 'dist');
app.use(express.static(distPath));
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api')) return next();
  res.sendFile(path.join(distPath, 'index.html'), (err) => {
    if (err) next(); // dist not built yet in dev
  });
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
async function start() {
  try {
    await initDb();

    app.listen(PORT, () => {
      console.log(`[server] Listening on http://localhost:${PORT}`);
    });

    // Periodic expiry sweep every 5 seconds
    const db = await getDb();
    setInterval(() => sweepAndBroadcast(db), 5_000);
  } catch (err) {
    console.error('[server] Failed to start:', err);
    process.exit(1);
  }
}

start();
