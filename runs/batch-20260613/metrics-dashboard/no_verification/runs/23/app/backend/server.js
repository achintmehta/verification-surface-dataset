import express from 'express';
import cors from 'cors';
import { getDb } from './db.js';
import { seed } from './seed.js';
import summaryRouter from './routes/summary.js';
import timeseriesRouter from './routes/timeseries.js';
import categoriesRouter from './routes/categories.js';
import recentRouter from './routes/recent.js';
import settingsRouter from './routes/settings.js';

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

// Routes
app.use('/api/summary', summaryRouter);
app.use('/api/timeseries', timeseriesRouter);
app.use('/api/categories', categoriesRouter);
app.use('/api/recent', recentRouter);
app.use('/api/settings', settingsRouter);

// Health check
app.get('/api/health', (_req, res) => res.json({ ok: true }));

async function start() {
  try {
    const db = await getDb();
    await seed(db);
    app.listen(PORT, () => {
      console.log(`[server] Backend running on http://localhost:${PORT}`);
    });
  } catch (err) {
    console.error('[server] Failed to start:', err);
    process.exit(1);
  }
}

start();
