const express = require('express');
const cors = require('cors');
const path = require('path');
const { initDB } = require('./db');
const { createRoutes } = require('./routes');

const PORT = process.env.PORT || 3001;

async function main() {
  const app = express();

  app.use(cors());
  app.use(express.json());

  // Serve static frontend build if it exists
  const frontendDist = path.join(__dirname, '..', 'frontend', 'dist');
  app.use(express.static(frontendDist));

  const db = await initDB();
  createRoutes(app, db);

  // SPA fallback
  app.get('*', (_req, res) => {
    res.sendFile(path.join(frontendDist, 'index.html'));
  });

  app.listen(PORT, () => {
    console.log(`Backend running on http://localhost:${PORT}`);
  });
}

main().catch(err => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
