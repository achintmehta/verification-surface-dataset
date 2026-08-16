const express = require('express');
const cors = require('cors');
const path = require('path');
const { initializeDatabase } = require('./db');
const routes = require('./routes');

const PORT = process.env.PORT || 3000;

async function main() {
  // Initialize database
  await initializeDatabase();
  console.log('Database initialized');

  const app = express();

  // Middleware
  app.use(cors({
    origin: true,
    credentials: true,
  }));
  app.use(express.json());

  // Serve static frontend files in production
  const clientDist = path.join(__dirname, '..', 'client', 'dist');
  app.use(express.static(clientDist));

  // API routes
  app.use('/api', routes);

  // SPA fallback
  app.get('*', (req, res) => {
    res.sendFile(path.join(clientDist, 'index.html'));
  });

  app.listen(PORT, () => {
    console.log(`Kanban server running on http://localhost:${PORT}`);
  });
}

main().catch(err => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
