import { Router } from 'express';
import { getDb } from '../db.js';

const router = Router();

router.get('/', async (_req, res) => {
  try {
    const db = await getDb();
    const { rows } = await db.query(`
      SELECT name, value::FLOAT AS value
      FROM categories
      ORDER BY value DESC
    `);
    res.json(rows.map(r => ({
      name:  r.name,
      value: Number(r.value),
    })));
  } catch (err) {
    console.error('[categories]', err);
    res.status(500).json({ error: 'Failed to fetch categories' });
  }
});

export default router;
