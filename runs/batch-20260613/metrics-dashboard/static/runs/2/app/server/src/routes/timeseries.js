/**
 * GET /api/timeseries
 *
 * Returns the 30-day daily_metrics series ordered by date ascending.
 * Each row: { date, visitors, revenue }
 */

import { Router } from 'express';
import { getDb } from '../db.js';

const router = Router();

router.get('/', async (_req, res) => {
  try {
    const db = await getDb();
    const { rows: raw } = await db.query(`
      SELECT
        date,
        visitors,
        revenue::FLOAT AS revenue
      FROM daily_metrics
      ORDER BY date ASC
    `);
    // Normalise date to YYYY-MM-DD string regardless of PGLite return type
    const rows = raw.map(r => ({
      date: r.date instanceof Date
        ? r.date.toISOString().slice(0, 10)
        : String(r.date).slice(0, 10),
      visitors: parseInt(r.visitors, 10),
      revenue:  parseFloat(r.revenue),
    }));
    res.json(rows);
  } catch (err) {
    console.error('[timeseries]', err);
    res.status(500).json({ error: 'Failed to fetch timeseries' });
  }
});

export default router;
