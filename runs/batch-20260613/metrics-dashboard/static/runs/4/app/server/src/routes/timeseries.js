import { Router } from 'express';
import { getDb } from '../db.js';

const router = Router();

router.get('/', async (_req, res) => {
  try {
    const db = await getDb();
    const { rows } = await db.query(`
      SELECT date, visitors, revenue::FLOAT AS revenue
      FROM daily_metrics
      ORDER BY date ASC
    `);
    res.json(rows.map(r => ({
      date:     r.date instanceof Date ? r.date.toISOString().slice(0, 10) : String(r.date).slice(0, 10),
      visitors: Number(r.visitors),
      revenue:  Number(r.revenue),
    })));
  } catch (err) {
    console.error('[timeseries]', err);
    res.status(500).json({ error: 'Failed to fetch timeseries' });
  }
});

export default router;
