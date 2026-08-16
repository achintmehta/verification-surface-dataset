import express from 'express';
import cors from 'cors';
import { getDb, initSchema, createIndexes, isSeeded } from './db.js';
import { seedDatabase } from './seed.js';
import { createRouter } from './routes.js';

const PORT = process.env.PORT || 3001;

async function main() {
  const bootStart = Date.now();
  console.log('Starting Log Explorer backend...');

  const db = await getDb();
  console.log('PGLite initialized.');

  // Create schema
  await initSchema(db);

  // Check if already seeded
  const alreadySeeded = await isSeeded(db);
  if (alreadySeeded) {
    console.log('Database already seeded, skipping seed step.');
  } else {
    await seedDatabase(db);
    // Create indexes after bulk insert for faster seeding
    console.log('Creating indexes...');
    await createIndexes(db);
    console.log('Indexes created.');

    // Analyze tables for query planner
    await db.exec('ANALYZE logs;');
    console.log('ANALYZE complete.');
  }

  // Set up Express
  const app = express();
  app.use(cors());
  app.use(express.json());

  // Mount API routes
  const apiRouter = createRouter(db);
  app.use('/api', apiRouter);

  // Health check
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
  });

  // Start server
  app.listen(PORT, () => {
    const elapsed = ((Date.now() - bootStart) / 1000).toFixed(1);
    console.log(`Log Explorer backend listening on port ${PORT} (boot time: ${elapsed}s)`);
  });
}

main().catch((err) => {
  console.error('Fatal error during startup:', err);
  process.exit(1);
});
