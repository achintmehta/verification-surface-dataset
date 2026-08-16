const express = require('express');
const cors = require('cors');
const path = require('path');
const { initDb } = require('./db');
const { startExpirySweep } = require('./expiry');
const routes = require('./routes');

const PORT = process.env.PORT || 3000;

async function main() {
  // Initialize database
  console.log('Initializing database...');
  await initDb();
  console.log('Database ready.');

  const app = express();

  // Middleware
  app.use(cors());
  app.use(express.json());

  // Serve static frontend in production
  app.use(express.static(path.join(__dirname, '..', 'frontend')));

  // API routes
  app.use('/api', routes);

  // Fallback to index.html for SPA
  app.get('*', (req, res) => {
    if (!req.path.startsWith('/api')) {
      res.sendFile(path.join(__dirname, '..', 'frontend', 'index.html'));
    }
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
