import express from "express";
import cors from "cors";
import { getDb } from "./db.js";
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
    const db = await getDb();
    const result = await db.query(
      "SELECT id, text, created_at FROM messages ORDER BY created_at ASC"
    );
    res.json(result.rows);
  } catch (err) {
    console.error("[api] GET /api/messages error:", err);
    res.status(500).json({ error: "Failed to fetch messages" });
  }
});

// ---------------------------------------------------------------------------
// POST /api/messages – insert a new message and broadcast via SSE
// ---------------------------------------------------------------------------
app.post("/api/messages", async (req, res) => {
  const { text } = req.body;

  if (!text || typeof text !== "string" || text.trim().length === 0) {
    return res.status(400).json({ error: "text is required" });
  }

  try {
    const db = await getDb();
    const result = await db.query(
      "INSERT INTO messages (text) VALUES ($1) RETURNING id, text, created_at",
      [text.trim()]
    );

    const message = result.rows[0];

    // Broadcast the new message to all SSE clients
    broadcast(message);

    res.status(201).json(message);
  } catch (err) {
    console.error("[api] POST /api/messages error:", err);
    res.status(500).json({ error: "Failed to create message" });
  }
});

// ---------------------------------------------------------------------------
// GET /api/stream – SSE endpoint for real-time updates
// ---------------------------------------------------------------------------
app.get("/api/stream", (req, res) => {
  addClient(req, res);
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
async function main() {
  // Ensure the database is ready before accepting requests
  await getDb();

  app.listen(PORT, () => {
    console.log(`[server] listening on http://localhost:${PORT}`);
  });
}

main().catch((err) => {
  console.error("[server] fatal:", err);
  process.exit(1);
});
