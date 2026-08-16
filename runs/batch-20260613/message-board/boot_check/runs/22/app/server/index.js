const express = require("express");
const cors = require("cors");
const { getDb } = require("./db");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// ---------------------------------------------------------------------------
// SSE connection management
// ---------------------------------------------------------------------------
const clients = new Set();

function broadcastMessage(message) {
  const data = JSON.stringify(message);
  for (const res of clients) {
    res.write(`data: ${data}\n\n`);
  }
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

// GET /api/messages – fetch all historical messages
app.get("/api/messages", async (_req, res) => {
  try {
    const db = await getDb();
    const result = await db.query(
      "SELECT id, text, created_at FROM messages ORDER BY created_at ASC"
    );
    res.json(result.rows);
  } catch (err) {
    console.error("Error fetching messages:", err);
    res.status(500).json({ error: "Failed to fetch messages" });
  }
});

// POST /api/messages – insert a new message and broadcast it
app.post("/api/messages", async (req, res) => {
  const { text } = req.body;

  if (!text || typeof text !== "string" || text.trim().length === 0) {
    return res.status(400).json({ error: "Message text is required" });
  }

  try {
    const db = await getDb();
    const result = await db.query(
      "INSERT INTO messages (text) VALUES ($1) RETURNING id, text, created_at",
      [text.trim()]
    );
    const newMessage = result.rows[0];

    // Broadcast to all connected SSE clients
    broadcastMessage(newMessage);

    res.status(201).json(newMessage);
  } catch (err) {
    console.error("Error inserting message:", err);
    res.status(500).json({ error: "Failed to insert message" });
  }
});

// GET /api/stream – Server-Sent Events endpoint
app.get("/api/stream", (req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  // Send an initial comment to flush headers / confirm connection
  res.write(":connected\n\n");

  clients.add(res);
  console.log(`SSE client connected. Total clients: ${clients.size}`);

  req.on("close", () => {
    clients.delete(res);
    console.log(`SSE client disconnected. Total clients: ${clients.size}`);
  });
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
async function start() {
  // Ensure the database is initialized before accepting requests
  await getDb();

  app.listen(PORT, () => {
    console.log(`Server listening on http://localhost:${PORT}`);
  });
}

start().catch((err) => {
  console.error("Failed to start server:", err);
  process.exit(1);
});
