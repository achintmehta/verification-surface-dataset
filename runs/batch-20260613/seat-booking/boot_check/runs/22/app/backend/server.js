import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { initDb, getDb } from './db.js';
import { createSeatRoutes } from './routes/seats.js';
import { createHoldRoutes } from './routes/holds.js';
import { createStreamRoutes, broadcastSeatChanges } from './routes/stream.js';
import { expireHolds } from './services/expiry.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Serve static frontend files
app.use(express.static(path.join(__dirname, '..', 'frontend')));

async function start() {
  await initDb();

  // Mount routes
  app.use('/api', createSeatRoutes());
  app.use('/api', createHoldRoutes(broadcastSeatChanges));
  app.use('/api', createStreamRoutes());

  // Periodic sweep for expired holds every 2 seconds
  setInterval(async () => {
    try {
      const released = await expireHolds();
      if (released.length > 0) {
        broadcastSeatChanges(released);
      }
    } catch (err) {
      console.error('Expiry sweep error:', err);
    }
  }, 2000);

  app.listen(PORT, () => {
    console.log(`Seat booking server listening on port ${PORT}`);
  });
}

start().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
