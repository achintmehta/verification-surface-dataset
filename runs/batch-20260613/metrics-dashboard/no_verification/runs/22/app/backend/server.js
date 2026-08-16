import express from 'express';
import cors from 'cors';
import { initDb } from './db.js';
import summaryRoutes from './routes/summary.js';
import timeseriesRoutes from './routes/timeseries.js';
import categoriesRoutes from './routes/categories.js';
import recentRoutes from './routes/recent.js';
import settingsRoutes from './routes/settings.js';

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

// Routes
app.use('/api/summary', summaryRoutes);
app.use('/api/timeseries', timeseriesRoutes);
app.use('/api/categories', categoriesRoutes);
app.use('/api/recent', recentRoutes);
app.use('/api/settings', settingsRoutes);

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok' });
});

async function start() {
  try {
    await initDb();
    app.listen(PORT, () => {
      console.log(`Backend server running on http://localhost:${PORT}`);
    });
  } catch (err) {
    console.error('Failed to start server:', err);
    process.exit(1);
  }
}

start();
