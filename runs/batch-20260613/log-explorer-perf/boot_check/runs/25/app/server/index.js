const express = require('express');
const cors = require('cors');
const path = require('path');
const { initDB } = require('./db');
const { createLogsRouter } = require('./routes');

const PORT = process.env.PORT || 3001;

async function main() {
  const app = express();
  app.use(cors());
  app.use(express.json());

  console.time('boot');
  const db = await initDB();
  console.timeEnd('boot');

  app.use('/api', createLogsRouter(db));

  // Serve static frontend in production
  const clientDist = path.join(__dirname, '..', 'client', 'dist');
  app.use(express.static(clientDist));

  app.listen(PORT, () => {
    console.log(`Server listening on http://localhost:${PORT}`);
  });
}

main().catch(err => {
  console.error('Fatal boot error:', err);
  process.exit(1);
});
