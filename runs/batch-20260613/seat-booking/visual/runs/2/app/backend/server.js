import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { initDb } from './db.js';
import { startExpirySweep } from './expiry.js';
import seatsRouter from './routes/seats.js';
import holdsRouter from './routes/holds.js';
import streamRouter from './routes/stream.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3001;

async function main() {
  // Initialize database
  await initDb();

  const app = express();

  // Middleware
  app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  }));
  app.use(express.json());

  // Routes
  app.use('/api/seats', seatsRouter);
  app.use('/api/holds', holdsRouter);
  app.use('/api/stream', streamRouter);

  // Health check
  app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  // Test-only: force-expire a hold immediately (for integration testing)
  if (process.env.NODE_ENV !== 'production') {
    app.post('/api/test/expire-hold', async (req, res) => {
      const { holdId } = req.body;
      const db = await (await import('./db.js')).getDb();
      await db.query(
        `UPDATE seats SET hold_expires_at = NOW() - INTERVAL '1 second'
         WHERE hold_id = $1 AND status = 'held'`,
        [holdId]
      );
      await db.query(
        `UPDATE holds SET expires_at = NOW() - INTERVAL '1 second' WHERE id = $1`,
        [holdId]
      );
      res.json({ ok: true });
    });
  }

  // Serve frontend static files
  const distPath = path.join(__dirname, '..', 'dist');
  app.use(express.static(distPath));
  app.get('*', (req, res) => {
    res.sendFile(path.join(distPath, 'index.html'));
  });

  // Start server
  app.listen(PORT, () => {
    console.log(`[server] Listening on http://localhost:${PORT}`);
  });

  // Start expiry sweep (every 5 seconds)
  await startExpirySweep(5000);
}

main().catch(err => {
  console.error('Fatal error during startup:', err);
  process.exit(1);
});
