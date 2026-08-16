import { Router } from 'express';
import { getDb } from '../db.js';

const router = Router();

router.get('/', async (req, res) => {
  try {
    const db = await getDb();
    const result = await db.query(
      `SELECT name, category, value, created_at FROM recent_items ORDER BY created_at DESC`
    );
    res.json(result.rows.map(row => ({
      name: row.name,
      category: row.category,
      value: parseFloat(row.value),
      createdAt: row.created_at
    })));
  } catch (err) {
    console.error('Error in /api/recent:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
