import express from 'express';
import cors from 'cors';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { initDb } from './database.js';
import {
  confirmHold,
  createHold,
  createSeatBroadcaster,
  getInventory,
  listSeats,
  releaseHold,
  sweepExpiredHolds,
} from './seatService.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const distDir = path.join(rootDir, 'dist');

const app = express();
const broadcaster = createSeatBroadcaster();
const port = Number(process.env.PORT || 3000);

app.use(cors());
app.use(express.json({ limit: '32kb' }));

app.get('/api/health', async (_req, res, next) => {
  try {
    res.json({ ok: true, inventory: await getInventory() });
  } catch (error) {
    next(error);
  }
});

app.get('/api/seats', async (_req, res, next) => {
  try {
    res.json(await listSeats(broadcaster));
  } catch (error) {
    next(error);
  }
});

app.get('/api/inventory', async (_req, res, next) => {
  try {
    res.json(await getInventory());
  } catch (error) {
    next(error);
  }
});

app.post('/api/holds', async (req, res, next) => {
  try {
    const hold = await createHold(req.body, broadcaster);
    res.status(201).json(hold);
  } catch (error) {
    next(error);
  }
});

app.post('/api/holds/:holdId/confirm', async (req, res, next) => {
  try {
    const result = await confirmHold(req.params.holdId, req.body?.sessionId, broadcaster);
    res.json(result);
  } catch (error) {
    next(error);
  }
});

app.delete('/api/holds/:holdId', async (req, res, next) => {
  try {
    const result = await releaseHold(req.params.holdId, req.body?.sessionId || req.query?.sessionId, broadcaster);
    res.json(result);
  } catch (error) {
    next(error);
  }
});

app.get('/api/stream', async (req, res, next) => {
  try {
    broadcaster.add(req, res);
    const snapshot = await listSeats(broadcaster);
    res.write(`event: snapshot\n`);
    res.write(`data: ${JSON.stringify(snapshot)}\n\n`);
  } catch (error) {
    next(error);
  }
});

app.use(express.static(distDir));
app.use((req, res, next) => {
  if (req.path.startsWith('/api/') || req.method !== 'GET') return next();
  res.sendFile(path.join(distDir, 'index.html'), (error) => {
    if (error) next();
  });
});

app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

app.use((error, _req, res, _next) => {
  const status = Number(error.status || 500);
  if (status >= 500) {
    console.error(error);
  }
  res.status(status).json({
    error: error.message || 'Internal server error',
    ...(error.details || {}),
  });
});

await initDb();
await sweepExpiredHolds(broadcaster);

setInterval(() => {
  sweepExpiredHolds(broadcaster).catch((error) => console.error('expiry sweep failed', error));
}, 1000).unref();

setInterval(() => broadcaster.heartbeat(), 25000).unref();

app.listen(port, () => {
  console.log(`Seat booking server listening on http://localhost:${port}`);
});
