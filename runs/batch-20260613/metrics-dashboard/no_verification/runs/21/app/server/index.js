import express from 'express';
import cors from 'cors';
import { getDb } from './db.js';
import { seed } from './seed.js';
import routes from './routes.js';

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());
app.use(routes);

async function start() {
  try {
    const db = await getDb();
    await seed(db);
    app.listen(PORT, () => {
      console.log(`Server running on http://localhost:${PORT}`);
    });
  } catch (err) {
    console.error('Failed to start server:', err);
    process.exit(1);
  }
}

start();
