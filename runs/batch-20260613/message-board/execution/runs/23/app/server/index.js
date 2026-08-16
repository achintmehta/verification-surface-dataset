import express from "express";
import cors from "cors";
import { getDB } from "./db.js";
import { addClient, broadcast } from "./sse.js";

const PORT = process.env.PORT || 3001;
const app = express();

app.use(cors());
app.use(express.json());

// ---------------------------------------------------------------------------
// GET /api/messages – return all historical messages (oldest first)
// ---------------------------------------------------------------------------
app.get("/api/messages", async (_req, res) => {
  try {
    const db = await getDB();
    const result = await db.query(
      "SELECT id, text, created_at FROM messages ORDER BY created_at ASC"
    );
    res.json(result.rows);
  } catch (err) {
    console.error("[api] Failed to fetch messages:", err);
    res.status(500).json({ error: "Failed to fetch messages" });
  }
});

// ---------------------------------------------------------------------------
// POST /api/messages – insert a new message and broadcast it via SSE
// ---------------------------------------------------------------------------
app.post("/api/messages", async (req, res) => {
  const { text } = req.body;

  if (!text || typeof text !== "string" || text.trim().length === 0) {
    return res.status(400).json({ error: "Message text is required" });
  }

  try {
    const db = await getDB();
    const result = await db.query(
      "INSERT INTO messages (text) VALUES ($1) RETURNING id, text, created_at",
      [text.trim()]
    );

    const newMessage = result.rows[0];

    // Broadcast to all SSE clients
    broadcast(newMessage);

    res.status(201).json(newMessage);
  } catch (err) {
    console.error("[api] Failed to insert message:", err);
    res.status(500).json({ error: "Failed to insert message" });
  }
});

// ---------------------------------------------------------------------------
// GET /api/stream – SSE endpoint for real-time updates
// ---------------------------------------------------------------------------
app.get("/api/stream", (req, res) => {
  addClient(req, res);
});

// ---------------------------------------------------------------------------
// Start the server after the database is ready
// ---------------------------------------------------------------------------
async function start() {
  await getDB(); // ensure DB is initialised before accepting requests

  app.listen(PORT, () => {
    console.log(`[server] Message board API running on http://localhost:${PORT}`);
  });
}

start().catch((err) => {
  console.error("[server] Fatal error during startup:", err);
  process.exit(1);
});
