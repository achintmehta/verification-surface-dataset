const express = require('express');
const cors = require('cors');
const path = require('path');
const { initDb, getDb } = require('./db');
const boardRoutes = require('./routes/board');
const cardRoutes = require('./routes/cards');
const streamRoute = require('./routes/stream');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Serve static frontend files in production
app.use(express.static(path.join(__dirname, '..', 'client')));

// API routes
app.use('/api', boardRoutes);
app.use('/api', cardRoutes);
app.use('/api', streamRoute);

async function start() {
  await initDb();
  app.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
  });
}

start().catch(err => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
