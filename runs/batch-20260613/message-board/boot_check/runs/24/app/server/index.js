import express from "express";
import cors from "cors";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getDb } from "./db.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Serve built frontend in production
const clientDist = path.join(__dirname, "..", "client", "dist");
app.use(express.static(clientDist));

// ── Active SSE connections ────────────────────────────────────────────
const clients = new Set();

// ── GET /api/messages — return all historical messages ────────────────
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

// ── GET /api/stream — SSE endpoint ───────────────────────────────────
app.get("/api/stream", (req, res) => {
  // Set SSE headers
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  // Send an initial comment so the client knows the connection is alive
  res.write(":ok\n\n");

  // Track this connection
  clients.add(res);
  console.log(`SSE client connected. Total clients: ${clients.size}`);

  // Remove on close
  req.on("close", () => {
    clients.delete(res);
    console.log(`SSE client disconnected. Total clients: ${clients.size}`);
  });
});

// ── POST /api/messages — create a new message and broadcast ──────────
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
    res.status(201).json(message);

    // Broadcast to every active SSE client
    const payload = `data: ${JSON.stringify(message)}\n\n`;
    for (const client of clients) {
      client.write(payload);
    }
  } catch (err) {
    console.error("Error inserting message:", err);
    res.status(500).json({ error: "Failed to create message" });
  }
});

// ── Fallback: serve index.html for SPA routing ───────────────────────
app.get("*", (_req, res) => {
  res.sendFile(path.join(clientDist, "index.html"));
});

// ── Start ─────────────────────────────────────────────────────────────
async function start() {
  // Eagerly initialise the DB so the table is ready before the first request
  await getDb();

  app.listen(PORT, () => {
    console.log(`Server listening on http://localhost:${PORT}`);
  });
}

start().catch((err) => {
  console.error("Failed to start server:", err);
  process.exit(1);
});
