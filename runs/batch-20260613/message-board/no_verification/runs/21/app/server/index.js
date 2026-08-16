import express from "express";
import cors from "cors";
import { initDB, getDB } from "./db.js";
import { addClient, removeClient, broadcast } from "./sse.js";

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

// ---------------------------------------------------------------------------
// GET /api/messages – return all historical messages ordered by creation time
// ---------------------------------------------------------------------------
app.get("/api/messages", async (_req, res) => {
  try {
    const db = getDB();
    const result = await db.query(
      "SELECT id, text, created_at FROM messages ORDER BY created_at ASC"
    );
    res.json(result.rows);
  } catch (err) {
    console.error("Failed to fetch messages:", err);
    res.status(500).json({ error: "Failed to fetch messages" });
  }
});

// ---------------------------------------------------------------------------
// POST /api/messages – insert a new message and broadcast it to SSE clients
// ---------------------------------------------------------------------------
app.post("/api/messages", async (req, res) => {
  const { text } = req.body;

  if (!text || typeof text !== "string" || text.trim().length === 0) {
    return res.status(400).json({ error: "Message text is required" });
  }

  try {
    const db = getDB();
    const result = await db.query(
      "INSERT INTO messages (text) VALUES ($1) RETURNING id, text, created_at",
      [text.trim()]
    );

    const message = result.rows[0];

    // Broadcast the new message to every connected SSE client
    broadcast(message);

    res.status(201).json(message);
  } catch (err) {
    console.error("Failed to insert message:", err);
    res.status(500).json({ error: "Failed to insert message" });
  }
});

// ---------------------------------------------------------------------------
// GET /api/stream – SSE endpoint for real-time updates
// ---------------------------------------------------------------------------
app.get("/api/stream", (req, res) => {
  // Set headers required for SSE
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  // Send an initial comment to flush headers / confirm connection
  res.write(":ok\n\n");

  // Register this client
  const clientId = addClient(res);

  // When the client disconnects, clean up
  req.on("close", () => {
    removeClient(clientId);
  });
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
async function start() {
  await initDB();
  app.listen(PORT, () => {
    console.log(`Server listening on http://localhost:${PORT}`);
  });
}

start().catch((err) => {
  console.error("Failed to start server:", err);
  process.exit(1);
});
