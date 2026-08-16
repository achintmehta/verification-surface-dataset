/**
 * GET /api/recent
 *
 * Returns the 20 most-recent items ordered by created_at descending.
 * Shape: { data: [{ id, name, category, value, createdAt }, …] }
 */

import { Router } from 'express';
import { getDb }   from '../db.js';

const router = Router();

router.get('/', async (_req, res, next) => {
  try {
    const db = getDb();
    const { rows } = await db.query(`
      SELECT id, name, category, value::numeric AS value, created_at
      FROM   recent_items
      ORDER  BY created_at DESC
      LIMIT  20
    `);

    res.json({
      data: rows.map(r => ({
        id:        r.id,
        name:      r.name,
        category:  r.category,
        value:     Number(r.value),
        createdAt: r.created_at instanceof Date
                     ? r.created_at.toISOString()
                     : String(r.created_at),
      })),
    });
  } catch (err) {
    next(err);
  }
});

export default router;
