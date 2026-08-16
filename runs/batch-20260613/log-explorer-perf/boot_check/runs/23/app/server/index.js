const express = require('express');
const cors = require('cors');
const path = require('path');
const { initDB } = require('./db');
const { createApiRouter } = require('./api');

const PORT = process.env.PORT || 3001;

async function main() {
  const startTime = Date.now();
  console.log('[boot] Starting log-explorer server...');

  const app = express();
  app.use(cors());
  app.use(express.json());

  // Initialize DB (schema + seed if needed)
  const db = await initDB();
  console.log(`[boot] DB ready in ${Date.now() - startTime}ms`);

  // Mount API
  app.use('/api', createApiRouter(db));

  // Serve static frontend files
  // Try dist first (built), then source (dev without Vite)
  const clientDist = path.join(__dirname, '..', 'client', 'dist');
  const clientSrc = path.join(__dirname, '..', 'client');
  app.use(express.static(clientDist));
  app.use(express.static(clientSrc));

  // SPA fallback
  app.get('/', (req, res) => {
    const fs = require('fs');
    const distIndex = path.join(clientDist, 'index.html');
    const srcIndex = path.join(clientSrc, 'index.html');
    if (fs.existsSync(distIndex)) {
      res.sendFile(distIndex);
    } else {
      res.sendFile(srcIndex);
    }
  });

  app.listen(PORT, () => {
    const elapsed = Date.now() - startTime;
    console.log(`[boot] Server listening on port ${PORT} (boot took ${elapsed}ms)`);
  });
}

main().catch(err => {
  console.error('[boot] Fatal error:', err);
  process.exit(1);
});
