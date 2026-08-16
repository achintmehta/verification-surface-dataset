import { Router } from 'express';

const router = Router();

router.get('/', async (req, res, next) => {
  try {
    const db = req.app.locals.db;
    const { rows } = await db.query(`
      SELECT
        name,
        value::float AS value
      FROM categories
      ORDER BY value DESC
    `);
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

export default router;
