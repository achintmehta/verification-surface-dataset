const express = require('express');
const cors = require('cors');
const { initDb } = require('./db');

const app = express();
app.use(cors());
app.use(express.json());

let db;

app.get('/api/logs', async (req, res) => {
  try {
    let { offset = 0, limit = 50, severity, q } = req.query;
    offset = parseInt(offset, 10);
    limit = parseInt(limit, 10);

    if (isNaN(offset) || offset < 0) {
      return res.status(400).json({ error: 'Invalid offset' });
    }
    if (isNaN(limit) || limit < 0 || limit > 200) {
      return res.status(400).json({ error: 'Invalid limit' });
    }
    if (severity && !['debug', 'info', 'warn', 'error'].includes(severity)) {
      return res.status(400).json({ error: 'Invalid severity' });
    }

    let conditions = [];
    let params = [];
    let paramIdx = 1;

    if (severity) {
      conditions.push(`severity = $${paramIdx++}`);
      params.push(severity);
    }
    if (q) {
      conditions.push(`message ILIKE $${paramIdx++}`);
      params.push(`%${q}%`);
    }

    let whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const countQuery = `SELECT count(*) FROM logs ${whereClause}`;
    const dataQuery = `SELECT * FROM logs ${whereClause} ORDER BY ts DESC LIMIT $${paramIdx++} OFFSET $${paramIdx++}`;
    
    const countRes = await db.query(countQuery, params);
    const total = parseInt(countRes.rows[0].count, 10);

    const dataRes = await db.query(dataQuery, [...params, limit, offset]);
    const rows = dataRes.rows;

    res.json({ total, rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/stats', async (req, res) => {
  try {
    const totalRes = await db.query('SELECT count(*) FROM logs');
    const total = parseInt(totalRes.rows[0].count, 10);

    const sevRes = await db.query('SELECT severity, count(*) FROM logs GROUP BY severity');
    const counts = { debug: 0, info: 0, warn: 0, error: 0 };
    for (const row of sevRes.rows) {
      counts[row.severity] = parseInt(row.count, 10);
    }

    res.json({ total, counts });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

const PORT = process.env.PORT || 3000;

initDb().then(database => {
  db = database;
  app.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
  });
}).catch(err => {
  console.error('Failed to initialize database', err);
  process.exit(1);
});
