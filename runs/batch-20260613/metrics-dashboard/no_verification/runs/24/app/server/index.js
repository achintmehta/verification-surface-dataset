const express = require('express');
const cors = require('cors');
const path = require('path');
const { initDB, getDB } = require('./db');
const apiRouter = require('./routes');

const PORT = process.env.PORT || 3001;

async function main() {
  await initDB();

  const app = express();
  app.use(cors());
  app.use(express.json());

  // API routes
  app.use('/api', apiRouter);

  // Serve static frontend in production
  const distPath = path.join(__dirname, '..', 'dist');
  const fs = require('fs');
  if (fs.existsSync(distPath)) {
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, () => {
    console.log(`Backend server running on http://localhost:${PORT}`);
  });
}

main().catch(err => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
