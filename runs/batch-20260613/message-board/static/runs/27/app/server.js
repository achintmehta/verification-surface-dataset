import express from 'express';
import cors from 'cors';
import { PGlite } from '@electric-sql/pglite';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const PORT = 3000;

// Middleware
app.use(cors());
app.use(express.json());

// Initialize PGLite with filesystem persistence
const db = new PGlite(join(__dirname, 'pgdata'));

// Active SSE clients
let sseClients = [];

// Initialize database
async function initDb() {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id SERIAL PRIMARY KEY,
      text TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);
  console.log('Database initialized');
}

// Broadcast message to all SSE clients
function broadcastMessage(message) {
  const data = `data: ${JSON.stringify(message)}\n\n`;
  sseClients.forEach((client, index) => {
    try {
      client.write(data);
    } catch (err) {
      // Remove dead connections
      sseClients.splice(index, 1);
    }
  });
}

// GET /api/messages - fetch all historical messages
app.get('/api/messages', async (req, res) => {
  try {
    const result = await db.query('SELECT * FROM messages ORDER BY created_at ASC');
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch messages' });
  }
});

// POST /api/messages - post a new message
app.post('/api/messages', async (req, res) => {
  const { text } = req.body;
  if (!text || typeof text !== 'string' || text.trim() === '') {
    return res.status(400).json({ error: 'Text is required' });
  }

  try {
    const result = await db.query(
      'INSERT INTO messages (text) VALUES ($1) RETURNING *',
      [text.trim()]
    );
    const newMessage = result.rows[0];
    
    // Broadcast to all connected clients
    broadcastMessage(newMessage);
    
    res.status(201).json(newMessage);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to post message' });
  }
});

// GET /api/stream - SSE endpoint for real-time updates
app.get('/api/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');

  // Send initial ping
  res.write(': connected\n\n');

  // Add client to active list
  sseClients.push(res);

  // Remove client on disconnect
  req.on('close', () => {
    sseClients = sseClients.filter(client => client !== res);
  });
});

// Start server
async function start() {
  await initDb();
  app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
    console.log(`Frontend: http://localhost:5173`);
  });
}

start().catch(console.error);