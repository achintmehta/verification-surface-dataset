import express from 'express';
import cors from 'cors';
import { initDB, getBoard, createCard, moveCard, broadcast } from './db.js';

const app = express();
const PORT = 3000;

app.use(cors());
app.use(express.json());

// SSE clients
let sseClients = [];

function addSSEClient(res) {
  sseClients.push(res);
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*'
  });
  res.write('data: {"type":"connected"}\n\n');
}

function broadcastToClients(data) {
  const payload = `data: ${JSON.stringify(data)}\n\n`;
  sseClients.forEach((client, index) => {
    try {
      client.write(payload);
    } catch (e) {
      sseClients.splice(index, 1);
    }
  });
}

// Override broadcast from db
global.broadcast = (data) => broadcastToClients(data);

app.get('/api/board', async (req, res) => {
  try {
    const board = await getBoard();
    res.json(board);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/cards', async (req, res) => {
  try {
    const { columnId, text } = req.body;
    const card = await createCard(columnId, text);
    res.json(card);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.patch('/api/cards/:id/move', async (req, res) => {
  try {
    const { id } = req.params;
    const { columnId, beforeId, afterId } = req.body;
    const card = await moveCard(id, columnId, beforeId, afterId);
    res.json(card);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/stream', (req, res) => {
  addSSEClient(res);

  req.on('close', () => {
    sseClients = sseClients.filter(c => c !== res);
  });
});

async function start() {
  await initDB();
  app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

start();