import { Router } from 'express';
import { getDb } from '../db.js';

const router = Router();

router.get('/', async (req, res) => {
  try {
    const db = await getDb();
    const result = await db.query(
      `SELECT date, visitors, revenue FROM daily_metrics ORDER BY date ASC`
    );
    res.json(result.rows.map(row => ({
      date: row.date,
      visitors: parseInt(row.visitors),
      revenue: parseFloat(row.revenue)
    })));
  } catch (err) {
    console.error('Error in /api/timeseries:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
