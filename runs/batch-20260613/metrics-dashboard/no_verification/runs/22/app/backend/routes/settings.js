import { Router } from 'express';
import { getDb } from '../db.js';

const router = Router();

router.get('/', async (req, res) => {
  try {
    const db = await getDb();
    const result = await db.query(
      `SELECT value FROM settings WHERE key = 'theme'`
    );
    const theme = result.rows.length > 0 ? result.rows[0].value : 'light';
    res.json({ theme });
  } catch (err) {
    console.error('Error in GET /api/settings:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.put('/', async (req, res) => {
  try {
    const { theme } = req.body;
    if (!theme || !['light', 'dark'].includes(theme)) {
      return res.status(400).json({ error: 'Invalid theme. Must be "light" or "dark".' });
    }

    const db = await getDb();
    await db.query(
      `UPDATE settings SET value = $1 WHERE key = 'theme'`,
      [theme]
    );
    res.json({ theme });
  } catch (err) {
    console.error('Error in PUT /api/settings:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
