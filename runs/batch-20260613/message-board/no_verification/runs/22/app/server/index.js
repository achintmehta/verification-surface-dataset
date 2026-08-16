import express from "express";
import cors from "cors";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getDb } from "./db.js";
import { addClient, broadcast } from "./sse.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3001;

const app = express();

app.use(cors());
app.use(express.json());

// ─── In production, serve the built client files ────────────────────────────
if (process.env.NODE_ENV === "production") {
  const clientDist = path.join(__dirname, "..", "client", "dist");
  app.use(express.static(clientDist));
}

// ─── GET /api/messages — fetch historical messages ──────────────────────────
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

// ─── POST /api/messages — create a new message ─────────────────────────────
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

    // Broadcast the newly created message to all SSE clients
    broadcast(message);

    res.status(201).json(message);
  } catch (err) {
    console.error("[api] POST /api/messages error:", err);
    res.status(500).json({ error: "Failed to create message" });
  }
});

// ─── GET /api/stream — SSE endpoint ─────────────────────────────────────────
app.get("/api/stream", (req, res) => {
  addClient(req, res);
});

// ─── Start ──────────────────────────────────────────────────────────────────
async function start() {
  // Eagerly initialize the database so the table is ready before any request
  await getDb();

  app.listen(PORT, () => {
    console.log(`[server] listening on http://localhost:${PORT}`);
  });
}

start().catch((err) => {
  console.error("[server] fatal error during startup:", err);
  process.exit(1);
});
