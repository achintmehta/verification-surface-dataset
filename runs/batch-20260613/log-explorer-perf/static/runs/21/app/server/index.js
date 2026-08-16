const express = require('express');
const cors = require('cors');
const path = require('path');
const { initDatabase } = require('./db');
const { createApiRouter } = require('./api');

const PORT = process.env.PORT || 3001;

async function main() {
  const startTime = Date.now();
  console.log('[boot] Starting log explorer server...');

  const app = express();
  app.use(cors());
  app.use(express.json());

  // Initialize database (schema + seed if needed)
  const db = await initDatabase();
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
  console.log(`[boot] Database ready in ${elapsed}s`);

  // API routes
  app.use('/api', createApiRouter(db));

  // Serve static client build if available
  const clientDist = path.join(__dirname, '..', 'client', 'dist');
  app.use(express.static(clientDist));
  app.get('*', (req, res) => {
    res.sendFile(path.join(clientDist, 'index.html'));
  });

  app.listen(PORT, () => {
    const totalElapsed = ((Date.now() - startTime) / 1000).toFixed(2);
    console.log(`[boot] Server listening on http://localhost:${PORT} (total boot: ${totalElapsed}s)`);
  });
}

main().catch((err) => {
  console.error('[boot] Fatal error:', err);
  process.exit(1);
});
