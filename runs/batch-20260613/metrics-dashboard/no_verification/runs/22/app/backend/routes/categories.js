import { Router } from 'express';
import { getDb } from '../db.js';

const router = Router();

router.get('/', async (req, res) => {
  try {
    const db = await getDb();
    const result = await db.query(
      `SELECT name, value FROM categories ORDER BY value DESC`
    );
    res.json(result.rows.map(row => ({
      name: row.name,
      value: parseInt(row.value)
    })));
  } catch (err) {
    console.error('Error in /api/categories:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
