import express from 'express';
import cors from 'cors';
import { initDb } from './db.js';
import { startExpirySweep } from './expiry.js';
import seatsRouter from './routes/seats.js';
import holdsRouter from './routes/holds.js';
import streamRouter from './routes/stream.js';

const PORT = process.env.PORT || 3001;

async function main() {
  // 1. Initialise the database
  const db = await initDb();
  console.log('PGLite database ready.');

  // 2. Start the periodic expiry sweep (every 5 seconds)
  startExpirySweep(db, 5000);

  // 3. Build the Express app
  const app = express();

  app.use(cors({ origin: '*' }));
  app.use(express.json());

  // Routes
  app.use('/api/seats', seatsRouter);
  app.use('/api/holds', holdsRouter);
  app.use('/api/stream', streamRouter);

  // Health check
  app.get('/api/health', (_req, res) => res.json({ status: 'ok' }));

  // 4. Start listening
  app.listen(PORT, () => {
    console.log(`Seat-booking server listening on http://localhost:${PORT}`);
  });
}

main().catch((err) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
