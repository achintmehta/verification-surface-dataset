import express from 'express';
import cors from 'cors';
import { initDb } from './db.js';
import { addClient } from './sse.js';
import boardRouter from './routes/board.js';
import cardsRouter from './routes/cards.js';

const PORT = process.env.PORT ?? 3001;

const app = express();

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(cors({ origin: '*' }));
app.use(express.json());

// ── Routes ────────────────────────────────────────────────────────────────────

// SSE stream – must be registered before any body-parsing middleware touches it
app.get('/api/stream', (req, res) => {
  addClient(req, res);
});

app.use('/api/board', boardRouter);
app.use('/api/cards', cardsRouter);

// Health check
app.get('/api/health', (_req, res) => res.json({ ok: true }));

// ── Bootstrap ─────────────────────────────────────────────────────────────────
async function start() {
  try {
    await initDb();
    app.listen(PORT, () => {
      console.log(`[server] Listening on http://localhost:${PORT}`);
    });
  } catch (err) {
    console.error('[server] Failed to start:', err);
    process.exit(1);
  }
}

start();
