import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { initDb } from './db.js';
import router from './routes.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3001;
const DIST_DIR = path.join(__dirname, '..', 'dist');

async function main() {
  await initDb();

  const app = express();

  app.use(cors({ origin: '*' }));
  app.use(express.json());

  app.use('/api', router);

  // Health check
  app.get('/health', (_req, res) => res.json({ ok: true }));

  // Serve built frontend (if dist exists)
  try {
    const { existsSync } = await import('fs');
    if (existsSync(DIST_DIR)) {
      app.use(express.static(DIST_DIR));
      app.get('*', (_req, res) => res.sendFile(path.join(DIST_DIR, 'index.html')));
    }
  } catch (_) {}

  app.listen(PORT, () => {
    console.log(`[server] listening on http://localhost:${PORT}`);
  });
}

main().catch(err => {
  console.error('[server] fatal:', err);
  process.exit(1);
});
