import { Router } from 'express';

export const statsRouter = Router();

statsRouter.get('/', async (req, res) => {
  const db = req.db;

  try {
    const result = await db.query(`
      SELECT
        COUNT(*) as total,
        COUNT(*) FILTER (WHERE severity = 'debug') as debug,
        COUNT(*) FILTER (WHERE severity = 'info')  as info,
        COUNT(*) FILTER (WHERE severity = 'warn')  as warn,
        COUNT(*) FILTER (WHERE severity = 'error') as error
      FROM logs
    `);

    const row = result.rows[0];
    return res.json({
      total: parseInt(row.total, 10),
      bySeverity: {
        debug: parseInt(row.debug, 10),
        info:  parseInt(row.info,  10),
        warn:  parseInt(row.warn,  10),
        error: parseInt(row.error, 10),
      },
    });
  } catch (err) {
    console.error('Error in GET /api/stats:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});
