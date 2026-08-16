const express = require('express');
const cors = require('cors');
const path = require('path');
const { initDB } = require('./db');
const { createLogsRouter } = require('./routes/logs');

const PORT = process.env.PORT || 3001;

async function main() {
  const bootStart = Date.now();
  console.log('[boot] Starting log-explorer server...');

  const db = await initDB();
  const bootMs = Date.now() - bootStart;
  console.log(`[boot] Database ready in ${bootMs}ms`);

  const app = express();
  app.use(cors());
  app.use(express.json());

  // Serve static client build if it exists
  const clientDist = path.join(__dirname, '..', 'client', 'dist');
  app.use(express.static(clientDist));

  // API routes
  app.use('/api', createLogsRouter(db));

  // SPA fallback
  app.get('*', (_req, res) => {
    res.sendFile(path.join(clientDist, 'index.html'));
  });

  app.listen(PORT, () => {
    const totalMs = Date.now() - bootStart;
    console.log(`[boot] Server listening on http://localhost:${PORT} (total boot: ${totalMs}ms)`);
  });
}

main().catch((err) => {
  console.error('[boot] Fatal error:', err);
  process.exit(1);
});
