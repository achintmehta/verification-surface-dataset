import { Router } from 'express';
import { getDb } from '../db.js';

const router = Router();

router.get('/', async (_req, res) => {
  try {
    const db = await getDb();
    const { rows } = await db.query(`
      SELECT
        date::text   AS date,
        visitors,
        revenue::float AS revenue
      FROM daily_metrics
      ORDER BY date ASC
    `);
    res.json(rows);
  } catch (err) {
    console.error('[timeseries]', err);
    res.status(500).json({ error: 'Failed to fetch time series' });
  }
});

export default router;
