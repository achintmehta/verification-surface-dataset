const express = require('express');
const cors = require('cors');
const { PGlite } = require('@electric-sql/pglite');

const app = express();
const PORT = 3000;

// Middleware
app.use(cors());
app.use(express.json());

// PGLite setup
let db;
const clients = new Set();

async function initDb() {
  db = new PGlite({ dataDir: './data' });
  await db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id SERIAL PRIMARY KEY,
      text TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);
  console.log('Database initialized');
}

// SSE endpoint
app.get('/api/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  clients.add(res);

  req.on('close', () => {
    clients.delete(res);
  });
});

// Get all messages
app.get('/api/messages', async (req, res) => {
  try {
    const result = await db.query('SELECT * FROM messages ORDER BY created_at ASC');
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching messages:', error);
    res.status(500).json({ error: 'Failed to fetch messages' });
  }
});

// Post new message
app.post('/api/messages', async (req, res) => {
  const { text } = req.body;
  if (!text || typeof text !== 'string') {
    return res.status(400).json({ error: 'Text is required' });
  }

  try {
    const result = await db.query(
      'INSERT INTO messages (text) VALUES ($1) RETURNING *',
      [text]
    );
    const newMessage = result.rows[0];

    // Broadcast to all SSE clients
    const data = `data: ${JSON.stringify(newMessage)}\n\n`;
    clients.forEach(client => {
      client.write(data);
    });

    res.status(201).json(newMessage);
  } catch (error) {
    console.error('Error posting message:', error);
    res.status(500).json({ error: 'Failed to post message' });
  }
});

// Start server
async function start() {
  await initDb();
  app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

start().catch(console.error);