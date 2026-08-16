import express from 'express';
import cors from 'cors';
import { initDB } from './db.js';
import routes from './routes.js';

const PORT = process.env.PORT || 3001;

async function main() {
  console.log('Log Explorer Server starting...');
  console.time('boot');

  await initDB();

  const app = express();
  app.use(cors());
  app.use(express.json());
  app.use(routes);

  app.listen(PORT, () => {
    console.timeEnd('boot');
    console.log(`Server listening on http://localhost:${PORT}`);
  });
}

main().catch((err) => {
  console.error('Fatal error during startup:', err);
  process.exit(1);
});
