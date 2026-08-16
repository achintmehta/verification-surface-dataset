import express from "express";
import cors from "cors";
import { getDb } from "./db.js";
import { addClient, broadcast } from "./sse.js";
import crypto from "crypto";

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

// ────────────────────────────────────────────────
// SSE endpoint
// ────────────────────────────────────────────────
app.get("/api/stream", (req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  // Send initial keepalive
  res.write(":ok\n\n");
  addClient(res);
});

// ────────────────────────────────────────────────
// GET /api/board – full board state
// ────────────────────────────────────────────────
app.get("/api/board", async (req, res) => {
  try {
    const db = await getDb();
    const colResult = await db.query(
      "SELECT id, title, position FROM columns ORDER BY position ASC"
    );
    const cardResult = await db.query(
      "SELECT id, column_id, text, position, created_at FROM cards ORDER BY position ASC"
    );

    const columns = colResult.rows.map((col) => ({
      ...col,
      cards: cardResult.rows
        .filter((c) => c.column_id === col.id)
        // Already ordered by position from the query, but ensure stability
        .sort((a, b) => a.position - b.position),
    }));

    res.json({ columns });
  } catch (err) {
    console.error("GET /api/board error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ────────────────────────────────────────────────
// POST /api/cards – create a card
// ────────────────────────────────────────────────
app.post("/api/cards", async (req, res) => {
  try {
    const { columnId, text } = req.body;
    if (!columnId || !text || !text.trim()) {
      return res.status(400).json({ error: "columnId and text are required" });
    }

    const db = await getDb();
    const id = "card-" + crypto.randomUUID();

    // Find the max position in the column to add at the end
    const maxResult = await db.query(
      "SELECT COALESCE(MAX(position), 0) as max_pos FROM cards WHERE column_id = $1",
      [columnId]
    );
    const position = maxResult.rows[0].max_pos + 1000;

    const insertResult = await db.query(
      `INSERT INTO cards (id, column_id, text, position)
       VALUES ($1, $2, $3, $4)
       RETURNING id, column_id, text, position, created_at`,
      [id, columnId, text.trim(), position]
    );

    const card = insertResult.rows[0];

    // Broadcast to all SSE clients
    broadcast("card-created", { card });

    res.status(201).json({ card });
  } catch (err) {
    console.error("POST /api/cards error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ────────────────────────────────────────────────
// PATCH /api/cards/:id/move – move / reorder a card
// ────────────────────────────────────────────────
app.patch("/api/cards/:id/move", async (req, res) => {
  try {
    const { id } = req.params;
    const { columnId, afterId, beforeId } = req.body;

    if (!columnId) {
      return res.status(400).json({ error: "columnId is required" });
    }

    const db = await getDb();

    // Compute the new position
    let newPosition = await computePosition(db, columnId, afterId, beforeId, id);

    // Perform the move atomically in a transaction
    await db.exec("BEGIN");
    try {
      await db.query(
        "UPDATE cards SET column_id = $1, position = $2 WHERE id = $3",
        [columnId, newPosition, id]
      );

      // Check for position collision in this column
      const collisionCheck = await db.query(
        `SELECT id FROM cards WHERE column_id = $1 AND position = $2 AND id != $3`,
        [columnId, newPosition, id]
      );

      let renormalized = false;
      let columnCards = null;

      if (collisionCheck.rows.length > 0) {
        // Collision detected – renormalize the column
        columnCards = await renormalizeColumn(db, columnId);
        renormalized = true;
      } else {
        // Check for precision exhaustion (positions too close together)
        const precisionCheck = await db.query(
          `SELECT id, position FROM cards WHERE column_id = $1 ORDER BY position ASC`,
          [columnId]
        );
        const positions = precisionCheck.rows;
        let needsRenorm = false;
        for (let i = 1; i < positions.length; i++) {
          const gap = positions[i].position - positions[i - 1].position;
          if (gap < 0.0001 && gap > 0) {
            needsRenorm = true;
            break;
          }
        }
        if (needsRenorm) {
          columnCards = await renormalizeColumn(db, columnId);
          renormalized = true;
        }
      }

      await db.exec("COMMIT");

      // Get the final card state
      const cardResult = await db.query(
        "SELECT id, column_id, text, position, created_at FROM cards WHERE id = $1",
        [id]
      );

      if (cardResult.rows.length === 0) {
        return res.status(404).json({ error: "Card not found" });
      }

      const card = cardResult.rows[0];

      if (renormalized && columnCards) {
        // Broadcast the full renormalized column
        broadcast("column-renormalized", {
          columnId,
          cards: columnCards,
        });
      } else {
        // Broadcast the move
        broadcast("card-moved", { card });
      }

      res.json({ card, renormalized: renormalized || false });
    } catch (txErr) {
      await db.exec("ROLLBACK");
      throw txErr;
    }
  } catch (err) {
    console.error("PATCH /api/cards/:id/move error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ────────────────────────────────────────────────
// DELETE /api/cards/:id – delete a card
// ────────────────────────────────────────────────
app.delete("/api/cards/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const db = await getDb();
    const result = await db.query(
      "DELETE FROM cards WHERE id = $1 RETURNING id, column_id",
      [id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Card not found" });
    }
    broadcast("card-deleted", { id, columnId: result.rows[0].column_id });
    res.json({ success: true });
  } catch (err) {
    console.error("DELETE /api/cards/:id error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────

async function computePosition(db, columnId, afterId, beforeId, movingCardId) {
  let afterPos = null;
  let beforePos = null;

  if (afterId) {
    const r = await db.query("SELECT position FROM cards WHERE id = $1", [afterId]);
    if (r.rows.length > 0) afterPos = r.rows[0].position;
  }

  if (beforeId) {
    const r = await db.query("SELECT position FROM cards WHERE id = $1", [beforeId]);
    if (r.rows.length > 0) beforePos = r.rows[0].position;
  }

  if (afterPos !== null && beforePos !== null) {
    // Insert between two cards
    return (afterPos + beforePos) / 2;
  } else if (afterPos !== null) {
    // Insert after a card (at the end)
    return afterPos + 1000;
  } else if (beforePos !== null) {
    // Insert before a card (at the beginning)
    return beforePos / 2;
  } else {
    // Only card in the column or no references
    // Find max position in this column (excluding the moving card)
    const maxResult = await db.query(
      "SELECT COALESCE(MAX(position), 0) as max_pos FROM cards WHERE column_id = $1 AND id != $2",
      [columnId, movingCardId]
    );
    const maxPos = maxResult.rows[0].max_pos;
    if (maxPos === 0) {
      return 1000;
    }
    return maxPos + 1000;
  }
}

async function renormalizeColumn(db, columnId) {
  const cards = await db.query(
    "SELECT id, column_id, text, position, created_at FROM cards WHERE column_id = $1 ORDER BY position ASC",
    [columnId]
  );

  for (let i = 0; i < cards.rows.length; i++) {
    const newPos = (i + 1) * 1000;
    await db.query("UPDATE cards SET position = $1 WHERE id = $2", [
      newPos,
      cards.rows[i].id,
    ]);
    cards.rows[i].position = newPos;
  }

  return cards.rows;
}

// ────────────────────────────────────────────────
// Start server
// ────────────────────────────────────────────────
async function start() {
  // Initialize DB on startup
  await getDb();
  console.log("Database initialized");

  app.listen(PORT, () => {
    console.log(`Backend server running on http://localhost:${PORT}`);
  });
}

start().catch((err) => {
  console.error("Failed to start server:", err);
  process.exit(1);
});
