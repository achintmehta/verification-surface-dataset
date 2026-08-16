import express from 'express';
import cors from 'cors';
import { PGlite } from '@electric-sql/pglite';

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Initialize PGLite
const db = new PGlite('./db');

// Initialize database schema
async function initDb() {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id SERIAL PRIMARY KEY,
      text TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);
}

initDb().catch(console.error);

// SSE Clients
let clients = [];

// GET /api/messages - Fetch historical messages
app.get('/api/messages', async (req, res) => {
  try {
    const result = await db.query('SELECT * FROM messages ORDER BY created_at ASC');
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch messages' });
  }
});

// GET /api/stream - SSE endpoint
app.get('/api/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  // Send initial connection message (optional)
  res.write(': connected\\n\\n');

  clients.push(res);

  req.on('close', () => {
    clients = clients.filter(client => client !== res);
  });
});

// POST /api/messages - Insert new message
app.post('/api/messages', async (req, res) => {
  const { text } = req.body;
  if (!text) {
    return res.status(400).json({ error: 'Text is required' });
  }

  try {
    const result = await db.query(
      'INSERT INTO messages (text) VALUES ($1) RETURNING *',
      [text]
    );
    const newMessage = result.rows[0];

    // Broadcast to all SSE clients
    clients.forEach(client => {
      client.write(`data: ${JSON.stringify(newMessage)}\\n\\n`);
    });

    res.status(201).json(newMessage);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to insert message' });
  }
});

app.listen(port, () => {
  console.log(`Server listening on port ${port}`);
});
