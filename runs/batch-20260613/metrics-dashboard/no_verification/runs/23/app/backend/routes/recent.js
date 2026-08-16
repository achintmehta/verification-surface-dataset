import { Router } from 'express';
import { getDb } from '../db.js';

const router = Router();

router.get('/', async (_req, res) => {
  try {
    const db = await getDb();
    const result = await db.query(
      'SELECT name, category, value::float AS value, created_at FROM recent_items ORDER BY created_at DESC'
    );
    res.json(result.rows);
  } catch (err) {
    console.error('[recent]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
