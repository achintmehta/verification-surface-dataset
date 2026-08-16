import { Router } from 'express';

const router = Router();

router.get('/', async (req, res, next) => {
  try {
    const db = req.app.locals.db;
    const { rows } = await db.query(`
      SELECT
        id,
        name,
        category,
        value::float AS value,
        created_at::text AS created_at
      FROM recent_items
      ORDER BY created_at DESC
      LIMIT 20
    `);
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

export default router;
