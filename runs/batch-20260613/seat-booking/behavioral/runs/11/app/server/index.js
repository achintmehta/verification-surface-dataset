import { createDb } from './db.js';
import { createApp } from './app.js';
import { DATA_DIR, PORT, SWEEP_INTERVAL_MS } from './config.js';

async function main() {
  const db = await createDb(DATA_DIR);
  const { app } = createApp(db, { sweepIntervalMs: SWEEP_INTERVAL_MS });

  app.listen(PORT, () => {
    console.log(`Seat-booking server listening on http://localhost:${PORT}`);
    console.log(`PGLite data dir: ${DATA_DIR}`);
  });
}

main().catch((err) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
