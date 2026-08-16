const express = require('express');
const cors = require('cors');
const path = require('path');
const { initDB } = require('./db');
const apiRoutes = require('./routes');

const PORT = process.env.PORT || 3000;

async function main() {
  const db = await initDB();

  const app = express();
  app.use(cors());
  app.use(express.json());

  // API routes
  app.use('/api', apiRoutes(db));

  // Serve static frontend files
  app.use(express.static(path.join(__dirname, '..', 'public')));

  // SPA fallback
  app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
  });

  app.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
  });
}

main().catch(err => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
