import express from 'express';
import cors from 'cors';
import { initDb } from './db.js';
import boardRouter  from './routes/board.js';
import cardsRouter  from './routes/cards.js';
import streamRouter from './routes/stream.js';

const PORT = process.env.PORT ?? 3001;

async function main() {
  // Initialise the database before accepting requests
  await initDb();
  console.log('PGLite database ready');

  const app = express();

  app.use(cors());
  app.use(express.json());

  // Routes
  app.use('/api/board',  boardRouter);
  app.use('/api/cards',  cardsRouter);
  app.use('/api/stream', streamRouter);

  // Generic error handler
  app.use((err, _req, res, _next) => {
    console.error(err);
    res.status(500).json({ error: err.message ?? 'Internal server error' });
  });

  app.listen(PORT, () => {
    console.log(`Kanban server listening on http://localhost:${PORT}`);
  });
}

main().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
