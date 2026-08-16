import { Router } from 'express';
import { getDb } from '../db.js';

const router = Router();

router.get('/', async (_req, res) => {
  try {
    const db = await getDb();
    const result = await db.query(
      'SELECT date, visitors, revenue::float AS revenue FROM daily_metrics ORDER BY date ASC'
    );
    res.json(result.rows);
  } catch (err) {
    console.error('[timeseries]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
