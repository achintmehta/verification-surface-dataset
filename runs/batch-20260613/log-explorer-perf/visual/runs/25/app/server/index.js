const express = require('express');
const cors = require('cors');
const path = require('path');
const { initDatabase, isReady } = require('./db');
const routes = require('./routes');

const PORT = process.env.PORT || 3001;
const app = express();

app.use(cors());
app.use(express.json());

// Health check that also indicates readiness
app.get('/api/health', (req, res) => {
  res.json({ status: isReady() ? 'ready' : 'initializing' });
});

// API routes
app.use('/api', routes);

// Serve static frontend in production
const distPath = path.join(__dirname, '..', 'dist');
app.use(express.static(distPath));
app.get('*', (req, res) => {
  res.sendFile(path.join(distPath, 'index.html'));
});

async function main() {
  const bootStart = Date.now();
  console.log('Starting Log Explorer server...');

  try {
    await initDatabase();
  } catch (err) {
    console.error('Failed to initialize database:', err);
    process.exit(1);
  }

  app.listen(PORT, () => {
    console.log(`Server listening on http://localhost:${PORT} (boot time: ${Date.now() - bootStart}ms)`);
  });
}

main();
