const express = require('express');
const cors = require('cors');
const { PGlite } = require('@electric-sql/pglite');

const app = express();
const PORT = 3000;

// Middleware
app.use(cors());
app.use(express.json());

// Initialize PGlite
const db = new PGlite('./.pglite');

// Store active SSE connections
let sseClients = new Set();

async function initDatabase() {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id SERIAL PRIMARY KEY,
      text TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);
  console.log('Database initialized');
}

// GET /api/messages - fetch historical messages
app.get('/api/messages', async (req, res) => {
  try {
    const result = await db.query('SELECT * FROM messages ORDER BY created_at ASC');
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching messages:', error);
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

    // Broadcast to all SSE clients
    broadcastMessage(newMessage);

    res.status(201).json(newMessage);
  } catch (error) {
    console.error('Error inserting message:', error);
    res.status(500).json({ error: 'Failed to post message' });
  }
});

// GET /api/stream - SSE endpoint
app.get('/api/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');

  // Send initial connection message
  res.write('data: {"type":"connected"}\n\n');

  // Add client to set
  sseClients.add(res);

  // Remove client on close
  req.on('close', () => {
    sseClients.delete(res);
  });
});

function broadcastMessage(message) {
  const data = JSON.stringify({ type: 'message', data: message });
  sseClients.forEach(client => {
    client.write(`data: ${data}\n\n`);
  });
}

// Start server
async function startServer() {
  await initDatabase();
  app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
    console.log(`Frontend should run on http://localhost:5173`);
  });
}

startServer().catch(console.error);