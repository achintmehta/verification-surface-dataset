const express = require('express');
const cors = require('cors');
const path = require('path');
const { initDb } = require('./db');
const routes = require('./routes');

const PORT = process.env.PORT || 3001;

async function main() {
  console.log('Initializing database...');
  const startTime = Date.now();

  await initDb();

  const dbTime = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`Database ready in ${dbTime}s`);

  const app = express();

  app.use(cors());
  app.use(express.json());

  // API routes
  app.use('/api', routes);

  // Serve static frontend in production
  const clientDist = path.join(__dirname, '..', 'client', 'dist');
  app.use(express.static(clientDist));
  app.get('*', (req, res) => {
    res.sendFile(path.join(clientDist, 'index.html'));
  });

  app.listen(PORT, () => {
    const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`Server listening on http://localhost:${PORT} (total boot: ${totalTime}s)`);
  });
}

main().catch((err) => {
  console.error('Fatal error during startup:', err);
  process.exit(1);
});
