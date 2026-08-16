import express from "express";
import cors from "cors";
import { getDb } from "./db.js";
import { addClient, broadcast } from "./sse.js";

const PORT = process.env.PORT || 3000;
const app = express();

app.use(cors());
app.use(express.json());

// ──────────────────────────────────────────────
// GET /api/messages – return all historical messages (oldest first)
// ──────────────────────────────────────────────
app.get("/api/messages", async (_req, res) => {
  try {
    const db = await getDb();
    const result = await db.query(
      "SELECT id, text, created_at FROM messages ORDER BY created_at ASC"
    );
    res.json(result.rows);
  } catch (err) {
    console.error("Failed to fetch messages:", err);
    res.status(500).json({ error: "Failed to fetch messages" });
  }
});

// ──────────────────────────────────────────────
// POST /api/messages – insert a new message & broadcast it
// ──────────────────────────────────────────────
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

    const message = result.rows[0];

    // Push the new message to every connected SSE client.
    broadcast("new-message", message);

    res.status(201).json(message);
  } catch (err) {
    console.error("Failed to insert message:", err);
    res.status(500).json({ error: "Failed to insert message" });
  }
});

// ──────────────────────────────────────────────
// GET /api/stream – SSE endpoint for real-time updates
// ──────────────────────────────────────────────
app.get("/api/stream", (req, res) => {
  addClient(req, res);
});

// ──────────────────────────────────────────────
// Start
// ──────────────────────────────────────────────
async function start() {
  // Ensure the DB is ready before accepting requests.
  await getDb();
  app.listen(PORT, () => {
    console.log(`Server listening on http://localhost:${PORT}`);
  });
}

start().catch((err) => {
  console.error("Failed to start server:", err);
  process.exit(1);
});
