const express = require('express');
const cors = require('cors');
const path = require('path');
const { initDatabase } = require('./db');
const { createApiRoutes } = require('./routes');

const PORT = process.env.PORT || 3001;

async function main() {
  const app = express();

  app.use(cors());
  app.use(express.json());

  // Serve built frontend in production
  const frontendDist = path.join(__dirname, '..', 'frontend', 'dist');
  app.use(express.static(frontendDist));

  const db = await initDatabase();

  // Mount API routes
  app.use('/api', createApiRoutes(db));

  // SPA fallback
  app.get('*', (req, res) => {
    res.sendFile(path.join(frontendDist, 'index.html'));
  });

  app.listen(PORT, () => {
    console.log(`Backend server running on http://localhost:${PORT}`);
  });
}

main().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
