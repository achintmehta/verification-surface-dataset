const express = require('express');
const cors = require('cors');
const { initDb } = require('./db');
const { registerRoutes } = require('./routes');

const PORT = process.env.PORT || 3000;

async function main() {
  const startTime = Date.now();
  console.log('[boot] Starting log explorer server...');

  const app = express();
  app.use(cors());
  app.use(express.json());

  console.log('[boot] Initializing database...');
  const db = await initDb();
  console.log(`[boot] Database ready in ${Date.now() - startTime}ms`);

  registerRoutes(app, db);

  app.listen(PORT, () => {
    const elapsed = Date.now() - startTime;
    console.log(`[boot] Server listening on http://localhost:${PORT} (total boot: ${elapsed}ms)`);
  });
}

main().catch(err => {
  console.error('[fatal]', err);
  process.exit(1);
});
