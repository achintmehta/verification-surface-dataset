import express from 'express';
import cors from 'cors';
import { initDb, getBoardState, createCard, moveCard, getCard } from './db.js';

const app = express();
const PORT = 3001;

app.use(cors());
app.use(express.json());

// SSE clients
let sseClients = [];

function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  sseClients.forEach((client, index) => {
    try {
      client.res.write(payload);
    } catch (e) {
      sseClients.splice(index, 1);
    }
  });
}

app.get('/api/board', async (req, res) => {
  try {
    const board = await getBoardState();
    res.json(board);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch board' });
  }
});

app.post('/api/cards', async (req, res) => {
  try {
    const { columnId, text } = req.body;
    if (!columnId || !text) {
      return res.status(400).json({ error: 'columnId and text required' });
    }
    const card = await createCard(columnId, text);
    broadcast('card-created', { card, columnId });
    res.status(201).json(card);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create card' });
  }
});

app.patch('/api/cards/:id/move', async (req, res) => {
  try {
    const { id } = req.params;
    const { columnId, beforeId, afterId } = req.body;
    if (!columnId) {
      return res.status(400).json({ error: 'columnId required' });
    }
    const updatedCard = await moveCard(id, columnId, beforeId, afterId);
    broadcast('card-moved', { card: updatedCard, columnId });
    res.json(updatedCard);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to move card' });
  }
});

app.get('/api/stream', async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');

  const client = { res };
  sseClients.push(client);

  // Send initial ping
  res.write('event: connected\ndata: {}\n\n');

  req.on('close', () => {
    sseClients = sseClients.filter(c => c !== client);
  });
});

async function start() {
  await initDb();
  app.listen(PORT, () => {
    console.log(`Kanban backend running on http://localhost:${PORT}`);
  });
}

start();
