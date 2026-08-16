const express = require('express');
const cors = require('cors');
const path = require('path');
const { initDb } = require('./db');
const routes = require('./routes');
const { startExpirySweep } = require('./expiry');

const PORT = process.env.PORT || 3000;

async function main() {
  // Initialize database
  console.log('Initializing database...');
  await initDb();
  console.log('Database initialized.');

  const app = express();

  app.use(cors());
  app.use(express.json());

  // Serve static frontend files in production
  const frontendDist = path.join(__dirname, '..', 'frontend', 'dist');
  app.use(express.static(frontendDist));

  // API routes
  app.use('/api', routes);

  // Fallback to index.html for SPA
  app.get('*', (req, res) => {
    res.sendFile(path.join(frontendDist, 'index.html'));
  });

  // Start expiry sweep (every 1 second)
  startExpirySweep(1000);

  app.listen(PORT, () => {
    console.log(`Seat booking server running on http://localhost:${PORT}`);
  });
}

main().catch(err => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
