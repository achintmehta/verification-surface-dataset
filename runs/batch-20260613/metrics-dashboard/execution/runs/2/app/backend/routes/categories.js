/**
 * GET /api/categories
 *
 * Returns all category rows ordered by value descending.
 * Shape: { data: [{ name, value }, …] }
 */

import { Router } from 'express';
import { getDb }   from '../db.js';

const router = Router();

router.get('/', async (_req, res, next) => {
  try {
    const db = getDb();
    const { rows } = await db.query(`
      SELECT name, value::numeric AS value
      FROM   categories
      ORDER  BY value DESC
    `);

    res.json({
      data: rows.map(r => ({
        name:  r.name,
        value: Number(r.value),
      })),
    });
  } catch (err) {
    next(err);
  }
});

export default router;
