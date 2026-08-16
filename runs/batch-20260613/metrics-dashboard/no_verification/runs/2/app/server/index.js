import express from 'express';
import cors from 'cors';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { existsSync } from 'fs';
import { initDb } from './db.js';
import { createApiRouter } from './routes.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3001;
const DIST_DIR = join(__dirname, '..', 'dist');

async function main() {
  const db = await initDb();

  const app = express();

  // Allow the Vite dev server to call the API
  app.use(cors({
    origin: ['http://localhost:5173', 'http://127.0.0.1:5173'],
    methods: ['GET', 'PUT', 'POST', 'DELETE', 'OPTIONS'],
  }));

  app.use(express.json());

  // API routes
  app.use('/api', createApiRouter(db));

  // Serve built frontend in production
  if (existsSync(DIST_DIR)) {
    app.use(express.static(DIST_DIR));
    app.get('*', (_req, res) => {
      res.sendFile(join(DIST_DIR, 'index.html'));
    });
  }

  app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
    if (existsSync(DIST_DIR)) {
      console.log(`Serving built frontend from ${DIST_DIR}`);
    } else {
      console.log('No dist/ found — run "npm run build" or use "npm run dev" for the Vite dev server.');
    }
  });
}

main().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
