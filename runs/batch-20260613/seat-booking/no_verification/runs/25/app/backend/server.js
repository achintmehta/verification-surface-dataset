import express from 'express';
import cors from 'cors';
import { initDb } from './db.js';
import { startPeriodicSweep } from './expiry.js';
import routes from './routes.js';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// Serve static frontend files in production
app.use(express.static(path.join(__dirname, '..', 'frontend', 'dist')));

// API routes
app.use('/api', routes);

// Fallback to index.html for SPA
app.get('*', (req, res) => {
  if (!req.path.startsWith('/api')) {
    res.sendFile(path.join(__dirname, '..', 'frontend', 'dist', 'index.html'));
  }
});

async function start() {
  try {
    await initDb();
    console.log('Database initialized');

    // Start periodic hold expiry sweep every 2 seconds
    startPeriodicSweep(2000);
    console.log('Periodic hold expiry sweep started');

    app.listen(PORT, () => {
      console.log(`Server listening on http://localhost:${PORT}`);
    });
  } catch (err) {
    console.error('Failed to start server:', err);
    process.exit(1);
  }
}

start();
