import express from 'express';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getDb } from './db.js';
import routes from './routes.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// API routes
app.use('/api', routes);

// Serve static frontend from dist (production build) or client (development)
const distPath = path.join(__dirname, '..', 'dist');
const clientPath = path.join(__dirname, '..', 'client');
const servePath = fs.existsSync(distPath) ? distPath : clientPath;
app.use(express.static(servePath));
app.get('*', (req, res) => {
  res.sendFile(path.join(servePath, 'index.html'));
});

async function start() {
  // Initialize DB
  await getDb();
  console.log('PGLite database initialized');

  app.listen(PORT, () => {
    console.log(`Kanban server running on http://localhost:${PORT}`);
  });
}

start().catch(err => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
