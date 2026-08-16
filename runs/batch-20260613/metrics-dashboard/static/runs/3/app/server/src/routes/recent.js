import { Router } from 'express';
import { getDb } from '../db.js';

const router = Router();

router.get('/', async (_req, res) => {
  try {
    const db = await getDb();
    const result = await db.query(`
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
    res.json(result.rows);
  } catch (err) {
    console.error('[/api/recent]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
