const express = require('express');
const cors = require('cors');
const path = require('path');
const { getDb } = require('./db');
const { router, setDb } = require('./routes');
const { startPeriodicSweep } = require('./expiry');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// Serve static frontend files in production
app.use(express.static(path.join(__dirname, '..', 'frontend')));

// API routes
app.use('/api', router);

// Start server
async function start() {
  try {
    const db = await getDb();
    setDb(db);
    console.log('Database initialized');

    // Start periodic hold expiry sweep (every 1 second)
    startPeriodicSweep(db, 1000);
    console.log('Periodic hold sweep started');

    app.listen(PORT, () => {
      console.log(`Seat booking server running on http://localhost:${PORT}`);
    });
  } catch (err) {
    console.error('Failed to start server:', err);
    process.exit(1);
  }
}

start();
