const express = require('express');
const cors = require('cors');
const path = require('path');
const { initDB, queryLogs, queryStats } = require('./db');

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

// Valid severities
const VALID_SEVERITIES = ['debug', 'info', 'warn', 'error'];

// GET /api/logs?offset=&limit=&severity=&q=
app.get('/api/logs', async (req, res) => {
  try {
    let { offset, limit, severity, q } = req.query;

    // Parse and validate offset
    offset = offset !== undefined ? parseInt(offset, 10) : 0;
    if (isNaN(offset) || offset < 0) {
      return res.status(400).json({ error: 'Invalid offset: must be a non-negative integer' });
    }

    // Parse and validate limit
    limit = limit !== undefined ? parseInt(limit, 10) : 50;
    if (isNaN(limit) || limit < 1 || limit > 200) {
      return res.status(400).json({ error: 'Invalid limit: must be between 1 and 200' });
    }

    // Validate severity
    if (severity !== undefined && severity !== '') {
      if (!VALID_SEVERITIES.includes(severity.toLowerCase())) {
        return res.status(400).json({ error: `Invalid severity: must be one of ${VALID_SEVERITIES.join(', ')}` });
      }
      severity = severity.toLowerCase();
    } else {
      severity = null;
    }

    // q is optional string
    const search = q && q.trim() !== '' ? q.trim() : null;

    const result = await queryLogs({ offset, limit, severity, search });
    res.json(result);
  } catch (err) {
    console.error('Error querying logs:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/stats
app.get('/api/stats', async (req, res) => {
  try {
    const stats = await queryStats();
    res.json(stats);
  } catch (err) {
    console.error('Error querying stats:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

async function main() {
  const startTime = Date.now();
  console.log('Initializing database...');
  await initDB();
  const dbTime = Date.now() - startTime;
  console.log(`Database initialized in ${dbTime}ms`);

  app.listen(PORT, () => {
    const totalTime = Date.now() - startTime;
    console.log(`Server ready on port ${PORT} (total boot: ${totalTime}ms)`);
  });
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
