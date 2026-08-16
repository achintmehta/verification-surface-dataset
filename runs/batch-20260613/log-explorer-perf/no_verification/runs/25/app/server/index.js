import express from 'express';
import cors from 'cors';
import { getDb, initSchema, createIndexes, isSeeded } from './db.js';
import { seedLogs } from './seed.js';
import { createRouter } from './routes.js';

const PORT = process.env.PORT || 3001;

async function main() {
  const bootStart = Date.now();
  console.log('Starting log explorer server...');

  const db = await getDb();
  console.log('PGLite initialized.');

  // Initialize schema
  await initSchema(db);

  // Check if already seeded
  const alreadySeeded = await isSeeded(db);
  if (alreadySeeded) {
    console.log('Database already seeded, skipping seed step.');
  } else {
    console.log('First boot detected, seeding database...');
    await seedLogs(db);
    console.log('Creating indexes...');
    await createIndexes(db);
    // Analyze tables for query planner
    await db.exec('ANALYZE logs;');
    console.log('Indexes created and analyzed.');
  }

  // Verify row count
  const countResult = await db.query('SELECT COUNT(*) as cnt FROM logs');
  console.log(`Database contains ${countResult.rows[0].cnt} log entries.`);

  // Create Express app
  const app = express();
  app.use(cors());
  app.use(express.json());

  // Mount API routes
  const router = createRouter(db);
  app.use(router);

  // Start server
  app.listen(PORT, () => {
    const elapsed = ((Date.now() - bootStart) / 1000).toFixed(1);
    console.log(`Server ready on port ${PORT} in ${elapsed}s`);
  });
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
