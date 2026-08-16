import express from 'express';
import cors from 'cors';
import { PGlite } from '@electric-sql/pglite';

const app = express();
const PORT = 3000;

// Middleware
app.use(cors());
app.use(express.json());

// PGLite setup - persists to local filesystem
const db = new PGlite('./pgdata');

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

// SSE clients
const clients = new Set();

// Broadcast new message to all connected clients
function broadcastMessage(message) {
  const data = `data: ${JSON.stringify(message)}\n\n`;
  clients.forEach(client => {
    client.write(data);
  });
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
    res.status(201).json(newMessage);
    // Broadcast to all SSE clients
    broadcastMessage(newMessage);
  } catch (error) {
    console.error('Error inserting message:', error);
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

  // Add client to set
  clients.add(res);

  // Remove client on disconnect
  req.on('close', () => {
    clients.delete(res);
  });
});

// Start server
async function startServer() {
  await initDb();
  app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
    console.log(`SSE endpoint: http://localhost:${PORT}/api/stream`);
  });
}

startServer().catch(console.error);