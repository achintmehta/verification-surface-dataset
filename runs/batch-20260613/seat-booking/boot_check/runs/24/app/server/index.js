import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { getDb } from './db.js';
import { createRoutes } from './routes.js';
import { startPeriodicSweep } from './expiry.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// Serve static frontend files in production
const clientDist = path.join(__dirname, '..', 'dist', 'client');
app.use(express.static(clientDist));

async function start() {
  try {
    const db = await getDb();
    console.log('PGLite database initialized');

    // Register API routes
    app.use(createRoutes(db));

    // Fallback to index.html for SPA routes (production)
    app.get('*', (req, res) => {
      if (!req.path.startsWith('/api')) {
        res.sendFile(path.join(clientDist, 'index.html'));
      }
    });

    // Start periodic hold expiry sweep (every 1 second)
    startPeriodicSweep(db, 1000);

    app.listen(PORT, () => {
      console.log(`Seat booking server listening on port ${PORT}`);
    });
  } catch (err) {
    console.error('Failed to start server:', err);
    process.exit(1);
  }
}

start();
