import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { initDB } from './db.js';
import { createApiRoutes } from './routes.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

async function start() {
  const db = await initDB();

  app.use('/api', createApiRoutes(db));

  // Serve static client files in production
  const clientDist = path.join(__dirname, '..', 'dist', 'client');
  const clientDev = path.join(__dirname, '..', 'client');

  // Try dist first, then fall back to client dir
  app.use(express.static(clientDist));
  app.use(express.static(clientDev));

  app.get('*', (req, res) => {
    const indexPath = path.join(clientDist, 'index.html');
    const devIndexPath = path.join(clientDev, 'index.html');
    import('fs').then(fs => {
      if (fs.existsSync(indexPath)) {
        res.sendFile(indexPath);
      } else {
        res.sendFile(devIndexPath);
      }
    });
  });

  app.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
  });
}

start().catch(err => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
