import express from 'express';
import cors from 'cors';
import { getDb } from './db.js';
import eventsRouter from './routes/events.js';

const PORT = process.env.PORT || 3001;

const app = express();

app.use(cors());
app.use(express.json());

app.use('/api/events', eventsRouter);

// Health check
app.get('/api/health', (_req, res) => res.json({ status: 'ok' }));

// Initialize DB then start listening
getDb()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Calendar API server listening on http://localhost:${PORT}`);
    });
  })
  .catch((err) => {
    console.error('Failed to initialize database:', err);
    process.exit(1);
  });
