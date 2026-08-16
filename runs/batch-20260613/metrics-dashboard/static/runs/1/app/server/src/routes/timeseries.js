import { Router } from 'express';

const router = Router();

router.get('/', async (req, res, next) => {
  try {
    const db = req.app.locals.db;
    const { rows } = await db.query(`
      SELECT
        date::text   AS date,
        visitors,
        revenue::float AS revenue
      FROM daily_metrics
      ORDER BY date ASC
    `);
    // Normalise date to YYYY-MM-DD string in case PGLite returns a Date object
    const normalised = rows.map(r => ({
      ...r,
      date: r.date instanceof Date
        ? r.date.toISOString().slice(0, 10)
        : String(r.date).slice(0, 10),
    }));
    res.json(normalised);
  } catch (err) {
    next(err);
  }
});

export default router;
