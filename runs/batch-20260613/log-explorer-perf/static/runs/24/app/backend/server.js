import express from 'express';
import cors from 'cors';
import { getDb } from './db.js';
import { seedDatabase } from './seed.js';
import { createLogsRouter } from './routes/logs.js';

const PORT = process.env.PORT || 3001;

async function main() {
  const startTime = Date.now();
  console.log('Starting Log Explorer backend...');

  // Initialize database
  console.log('Initializing PGLite database...');
  const db = await getDb();

  // Seed if needed
  const didSeed = await seedDatabase(db);
  const seedTime = Date.now() - startTime;
  console.log(`Database ready in ${seedTime}ms (seeded: ${didSeed})`);

  // Create Express app
  const app = express();
  app.use(cors());
  app.use(express.json());

  // Routes
  app.use('/api', createLogsRouter(db));

  // Health check
  app.get('/api/health', (req, res) => {
    res.json({ status: 'ok' });
  });

  // Start server
  app.listen(PORT, () => {
    const totalTime = Date.now() - startTime;
    console.log(`Log Explorer backend listening on port ${PORT} (boot time: ${totalTime}ms)`);
  });
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
