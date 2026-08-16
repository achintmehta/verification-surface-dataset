/**
 * Entry point: initializes the database, starts the HTTP server, and
 * schedules the periodic hold-expiry sweep.
 */

import path from 'path';
import { fileURLToPath } from 'url';
import { initDb, sweepExpiredHolds } from './db.js';
import { broadcast } from './sse.js';
import { createApp } from './app.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = process.env.PORT || 3001;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '../../data/pglite');

async function main() {
  console.log(`Initializing database at ${DATA_DIR} …`);
  const db = await initDb(DATA_DIR);
  console.log('Database ready.');

  const app = createApp();

  const server = app.listen(PORT, () => {
    console.log(`Seat-booking server listening on http://localhost:${PORT}`);
  });

  // Periodic sweep: release expired holds every 10 seconds
  const sweepInterval = setInterval(async () => {
    try {
      const released = await sweepExpiredHolds(db);
      if (released.length > 0) {
        console.log(`Sweep released ${released.length} seat(s):`, released);
        broadcast('seat-released', released.map((id) => ({ id, status: 'available' })));
      }
    } catch (err) {
      console.error('Sweep error:', err);
    }
  }, 10_000);

  // Graceful shutdown
  process.on('SIGTERM', () => {
    clearInterval(sweepInterval);
    server.close(() => process.exit(0));
  });
  process.on('SIGINT', () => {
    clearInterval(sweepInterval);
    server.close(() => process.exit(0));
  });
}

main().catch((err) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
