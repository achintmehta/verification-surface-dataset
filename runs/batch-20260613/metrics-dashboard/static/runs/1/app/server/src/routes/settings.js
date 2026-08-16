import { Router } from 'express';

const router = Router();

router.get('/', async (req, res, next) => {
  try {
    const db = req.app.locals.db;
    const { rows } = await db.query(
      `SELECT value FROM settings WHERE key = 'theme'`
    );
    const theme = rows[0]?.value ?? 'light';
    res.json({ theme });
  } catch (err) {
    next(err);
  }
});

router.put('/', async (req, res, next) => {
  try {
    const db = req.app.locals.db;
    const { theme } = req.body;
    if (theme !== 'light' && theme !== 'dark') {
      return res.status(400).json({ error: 'theme must be "light" or "dark"' });
    }
    await db.query(
      `INSERT INTO settings (key, value) VALUES ('theme', $1)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [theme]
    );
    res.json({ theme });
  } catch (err) {
    next(err);
  }
});

export default router;
