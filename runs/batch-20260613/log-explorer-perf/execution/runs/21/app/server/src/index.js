import express from 'express';
import cors from 'cors';
import { getDb, initSchema, isSeeded, seedLogs, createIndexes } from './db.js';
import { setupRoutes } from './routes.js';

const PORT = process.env.PORT || 3001;

async function main() {
  const bootStart = Date.now();
  console.log('Starting log explorer server...');

  const db = await getDb();
  console.log(`PGLite initialized in ${Date.now() - bootStart}ms`);

  await initSchema(db);
  console.log(`Schema ready in ${Date.now() - bootStart}ms`);

  const alreadySeeded = await isSeeded(db);
  if (alreadySeeded) {
    console.log('Database already seeded, skipping seed step.');
  } else {
    await seedLogs(db);
    await createIndexes(db);
  }

  console.log(`Database ready in ${Date.now() - bootStart}ms`);

  const app = express();
  app.use(cors());
  app.use(express.json());

  setupRoutes(app, db);

  app.listen(PORT, () => {
    console.log(`Server listening on port ${PORT} (total boot time: ${Date.now() - bootStart}ms)`);
  });
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
