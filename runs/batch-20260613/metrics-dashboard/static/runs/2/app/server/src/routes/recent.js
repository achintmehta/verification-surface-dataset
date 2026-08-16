/**
 * GET /api/recent
 *
 * Returns the 20 most recent items ordered by created_at descending.
 * Each row: { id, name, category, value, created_at }
 */

import { Router } from 'express';
import { getDb } from '../db.js';

const router = Router();

router.get('/', async (_req, res) => {
  try {
    const db = await getDb();
    const { rows } = await db.query(`
      SELECT
        id,
        name,
        category,
        value::FLOAT AS value,
        created_at
      FROM recent_items
      ORDER BY created_at DESC
      LIMIT 20
    `);
    res.json(rows);
  } catch (err) {
    console.error('[recent]', err);
    res.status(500).json({ error: 'Failed to fetch recent items' });
  }
});

export default router;
