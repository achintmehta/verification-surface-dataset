import express from 'express';
import cors from 'cors';
import { initDb, queryLogs, getStats } from './db.js';

const app = express();
app.use(cors());
app.use(express.json());

app.get('/api/logs', async (req, res) => {
  try {
    let { offset = 0, limit = 50, severity, q } = req.query;
    offset = parseInt(offset, 10);
    limit = parseInt(limit, 10);

    if (isNaN(offset) || offset < 0) {
      return res.status(400).json({ error: 'Invalid offset' });
    }
    if (isNaN(limit) || limit < 0 || limit > 200) {
      return res.status(400).json({ error: 'Invalid limit' });
    }
    if (severity && !['debug', 'info', 'warn', 'error'].includes(severity)) {
      return res.status(400).json({ error: 'Invalid severity' });
    }

    const result = await queryLogs({ offset, limit, severity, q });
    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/stats', async (req, res) => {
  try {
    const stats = await getStats();
    res.json(stats);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

const PORT = process.env.PORT || 3000;

initDb().then(() => {
  app.listen(PORT, () => {
    console.log(`Backend listening on port ${PORT}`);
  });
}).catch(err => {
  console.error('Failed to initialize DB', err);
  process.exit(1);
});
