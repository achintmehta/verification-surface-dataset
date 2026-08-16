const express = require('express');
const cors = require('cors');
const { initDatabase } = require('./db');
const { createRouter } = require('./routes');

const PORT = process.env.PORT || 3001;

async function main() {
  const startTime = Date.now();
  console.log('Starting log explorer server...');

  const db = await initDatabase();
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`Database ready in ${elapsed}s`);

  const app = express();
  app.use(cors());
  app.use(express.json());
  app.use('/api', createRouter(db));

  app.listen(PORT, () => {
    const totalElapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`Server listening on port ${PORT} (total startup: ${totalElapsed}s)`);
  });
}

main().catch(err => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
