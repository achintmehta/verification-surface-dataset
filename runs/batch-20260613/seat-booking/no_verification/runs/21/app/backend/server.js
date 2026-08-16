import express from 'express';
import cors from 'cors';
import { initDb } from './db.js';
import { startSweep } from './expiry.js';
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
app.use(express.static(path.join(__dirname, '..', 'frontend')));

// API routes
app.use('/api', routes);

// Start server
async function start() {
  try {
    await initDb();
    console.log('Database initialized');

    // Start periodic sweep for expired holds (every 5 seconds)
    startSweep(5000);
    console.log('Expiry sweep started');

    app.listen(PORT, () => {
      console.log(`Server running on http://localhost:${PORT}`);
    });
  } catch (err) {
    console.error('Failed to start server:', err);
    process.exit(1);
  }
}

start();
