const express = require('express');
const cors = require('cors');
const path = require('path');
const { initDB, seedDB } = require('./db');
const apiRoutes = require('./routes');

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

// Serve static frontend build if it exists
app.use(express.static(path.join(__dirname, '..', 'frontend', 'dist')));

async function start() {
  try {
    const db = await initDB();
    await seedDB(db);

    app.use('/api', apiRoutes(db));

    // SPA fallback
    app.get('*', (req, res) => {
      res.sendFile(path.join(__dirname, '..', 'frontend', 'dist', 'index.html'));
    });

    app.listen(PORT, () => {
      console.log(`Server running on http://localhost:${PORT}`);
    });
  } catch (err) {
    console.error('Failed to start server:', err);
    process.exit(1);
  }
}

start();
