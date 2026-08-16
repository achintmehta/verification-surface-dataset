/**
 * Metrics Dashboard – Express server entry point
 */

import express from 'express';
import cors    from 'cors';
import path    from 'path';
import { fileURLToPath } from 'url';

import { getDb }       from './db.js';
import summaryRouter   from './routes/summary.js';
import timeseriesRouter from './routes/timeseries.js';
import categoriesRouter from './routes/categories.js';
import recentRouter    from './routes/recent.js';
import settingsRouter  from './routes/settings.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app  = express();
const PORT = process.env.PORT || 3001;

/* ------------------------------------------------------------------ */
/*  Middleware                                                          */
/* ------------------------------------------------------------------ */
app.use(cors({ origin: 'http://localhost:5173', credentials: true }));
app.use(express.json());

/* ------------------------------------------------------------------ */
/*  API routes                                                          */
/* ------------------------------------------------------------------ */
app.use('/api/summary',    summaryRouter);
app.use('/api/timeseries', timeseriesRouter);
app.use('/api/categories', categoriesRouter);
app.use('/api/recent',     recentRouter);
app.use('/api/settings',   settingsRouter);

/* ------------------------------------------------------------------ */
/*  Serve built client (production)                                    */
/* ------------------------------------------------------------------ */
const clientDist = path.resolve(__dirname, '../../client/dist');
app.use(express.static(clientDist));
app.get('*', (_req, res) => {
  res.sendFile(path.join(clientDist, 'index.html'));
});

/* ------------------------------------------------------------------ */
/*  Boot                                                                */
/* ------------------------------------------------------------------ */
(async () => {
  try {
    await getDb();          // initialise + seed
    app.listen(PORT, () => {
      console.log(`[server] Listening on http://localhost:${PORT}`);
    });
  } catch (err) {
    console.error('[server] Fatal startup error:', err);
    process.exit(1);
  }
})();
