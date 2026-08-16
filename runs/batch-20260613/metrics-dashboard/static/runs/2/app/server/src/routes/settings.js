/**
 * GET  /api/settings  → { theme: "light" | "dark" }
 * PUT  /api/settings  ← { theme: "light" | "dark" }
 *                     → { theme: "light" | "dark" }
 */

import { Router } from 'express';
import { getDb } from '../db.js';

const router = Router();

router.get('/', async (_req, res) => {
  try {
    const db = await getDb();
    const { rows } = await db.query(`SELECT value FROM settings WHERE key = 'theme'`);
    const theme = rows[0]?.value ?? 'light';
    res.json({ theme });
  } catch (err) {
    console.error('[settings GET]', err);
    res.status(500).json({ error: 'Failed to fetch settings' });
  }
});

router.put('/', async (req, res) => {
  try {
    const { theme } = req.body;
    if (theme !== 'light' && theme !== 'dark') {
      return res.status(400).json({ error: 'theme must be "light" or "dark"' });
    }
    const db = await getDb();
    await db.query(
      `INSERT INTO settings (key, value) VALUES ('theme', $1)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [theme]
    );
    res.json({ theme });
  } catch (err) {
    console.error('[settings PUT]', err);
    res.status(500).json({ error: 'Failed to update settings' });
  }
});

export default router;
