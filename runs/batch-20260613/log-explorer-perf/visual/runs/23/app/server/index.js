const express = require('express');
const cors = require('cors');
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

  app.listen(PORT, () => {
    console.log(`Log Explorer API listening on http://localhost:${PORT}`);
  });
}

main().catch(err => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
