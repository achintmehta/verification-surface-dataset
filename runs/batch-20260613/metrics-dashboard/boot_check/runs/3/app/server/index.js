import express from 'express';
import cors from 'cors';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { initDb } from './db.js';
import { createApiRouter } from './routes.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const PORT = process.env.PORT || 3001;

async function main() {
  const app = express();

  app.use(cors({
    origin: ['http://localhost:5173', 'http://127.0.0.1:5173'],
    credentials: true,
  }));
  app.use(express.json());

  // Serve static files from client/dist in production
  const distPath = join(__dirname, '..', 'client', 'dist');
  app.use(express.static(distPath));

  console.log('Initializing database...');
  const db = await initDb();
  console.log('Database ready.');

  app.use('/api', createApiRouter(db));

  // Fallback: serve index.html for SPA routes (production)
  app.get('*', (req, res) => {
    const indexPath = join(distPath, 'index.html');
    res.sendFile(indexPath, (err) => {
      if (err) {
        res.status(404).json({ error: 'Not found' });
      }
    });
  });

  app.listen(PORT, () => {
    console.log(`Server listening on http://localhost:${PORT}`);
  });
}

main().catch((err) => {
  console.error('Fatal error during startup:', err);
  process.exit(1);
});
