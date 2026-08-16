import express from "express";
import cors from "cors";
import crypto from "crypto";
import { getDb } from "./db.js";
import { addClient, broadcast } from "./sse.js";
import {
  computePosition,
  needsRenormalization,
  renormalizeColumn,
  POSITION_GAP,
} from "./ordering.js";

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// ─── SSE endpoint ────────────────────────────────────────────────
app.get("/api/stream", (req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  // Send a comment to flush headers
  res.write(":ok\n\n");
  addClient(res);

  // Keep-alive every 30s
  const keepAlive = setInterval(() => {
    res.write(":ping\n\n");
  }, 30000);
  res.on("close", () => clearInterval(keepAlive));
});

// ─── GET /api/board ──────────────────────────────────────────────
app.get("/api/board", async (_req, res) => {
  try {
    const db = await getDb();
    const { rows: columns } = await db.query(
      "SELECT id, title, position FROM columns ORDER BY position ASC"
    );
    const { rows: cards } = await db.query(
      "SELECT id, column_id, text, position, created_at FROM cards ORDER BY position ASC, created_at ASC"
    );
    // Group cards by column
    const cardsByColumn = {};
    for (const col of columns) {
      cardsByColumn[col.id] = [];
    }
    for (const card of cards) {
      if (cardsByColumn[card.column_id]) {
        cardsByColumn[card.column_id].push(card);
      }
    }
    const board = columns.map((col) => ({
      ...col,
      cards: cardsByColumn[col.id] || [],
    }));
    res.json({ columns: board });
  } catch (err) {
    console.error("GET /api/board error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ─── POST /api/cards ─────────────────────────────────────────────
app.post("/api/cards", async (req, res) => {
  try {
    const db = await getDb();
    const { columnId, text } = req.body;
    if (!columnId || !text || !text.trim()) {
      return res.status(400).json({ error: "columnId and text are required" });
    }

    // Verify column exists
    const { rows: colRows } = await db.query(
      "SELECT id FROM columns WHERE id = $1",
      [columnId]
    );
    if (colRows.length === 0) {
      return res.status(404).json({ error: "Column not found" });
    }

    // Get the max position in the column
    const { rows: maxRows } = await db.query(
      "SELECT MAX(position) AS max_pos FROM cards WHERE column_id = $1",
      [columnId]
    );
    const maxPos = maxRows[0].max_pos;
    const position = maxPos != null ? maxPos + POSITION_GAP : POSITION_GAP;

    const id = "card-" + crypto.randomUUID();
    const { rows } = await db.query(
      `INSERT INTO cards (id, column_id, text, position)
       VALUES ($1, $2, $3, $4)
       RETURNING id, column_id, text, position, created_at`,
      [id, columnId, text.trim(), position]
    );
    const card = rows[0];

    broadcast("card-created", { card });
    res.status(201).json({ card });
  } catch (err) {
    console.error("POST /api/cards error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ─── PATCH /api/cards/:id/move ───────────────────────────────────
app.patch("/api/cards/:id/move", async (req, res) => {
  try {
    const db = await getDb();
    const cardId = req.params.id;
    const { columnId, afterId, beforeId } = req.body;

    if (!columnId) {
      return res.status(400).json({ error: "columnId is required" });
    }

    // Verify card exists
    const { rows: cardRows } = await db.query(
      "SELECT id, column_id, position FROM cards WHERE id = $1",
      [cardId]
    );
    if (cardRows.length === 0) {
      return res.status(404).json({ error: "Card not found" });
    }

    // Verify target column exists
    const { rows: colRows } = await db.query(
      "SELECT id FROM columns WHERE id = $1",
      [columnId]
    );
    if (colRows.length === 0) {
      return res.status(404).json({ error: "Column not found" });
    }

    const oldColumnId = cardRows[0].column_id;

    // Get positions of afterId and beforeId
    let afterPos = null;
    let beforePos = null;

    if (afterId) {
      const { rows } = await db.query(
        "SELECT position FROM cards WHERE id = $1 AND column_id = $2",
        [afterId, columnId]
      );
      if (rows.length > 0) {
        afterPos = rows[0].position;
      }
    }

    if (beforeId) {
      const { rows } = await db.query(
        "SELECT position FROM cards WHERE id = $1 AND column_id = $2",
        [beforeId, columnId]
      );
      if (rows.length > 0) {
        beforePos = rows[0].position;
      }
    }

    // If no reference cards provided, move to end of column
    if (!afterId && !beforeId) {
      const { rows: maxRows } = await db.query(
        "SELECT MAX(position) AS max_pos FROM cards WHERE column_id = $1 AND id != $2",
        [columnId, cardId]
      );
      afterPos = maxRows[0].max_pos;
    }

    const newPosition = computePosition(afterPos, beforePos);
    const shouldRenormalize = needsRenormalization(afterPos, beforePos);

    // Atomic update: column_id and position in a single statement
    await db.query(
      "UPDATE cards SET column_id = $1, position = $2 WHERE id = $3",
      [columnId, newPosition, cardId]
    );

    // Get the updated card
    const { rows: updatedRows } = await db.query(
      "SELECT id, column_id, text, position, created_at FROM cards WHERE id = $1",
      [cardId]
    );
    const updatedCard = updatedRows[0];

    // Broadcast the move — only after the update is committed
    broadcast("card-moved", {
      card: updatedCard,
      oldColumnId,
    });

    // Renormalize if needed (position gap exhaustion)
    if (shouldRenormalize) {
      const updates = await renormalizeColumn(db, columnId);
      if (oldColumnId !== columnId) {
        const oldUpdates = await renormalizeColumn(db, oldColumnId);
        if (oldUpdates.length > 0) {
          broadcast("column-renormalized", {
            columnId: oldColumnId,
            cards: oldUpdates,
          });
        }
      }
      if (updates.length > 0) {
        broadcast("column-renormalized", {
          columnId,
          cards: updates,
        });
      }
    }

    res.json({ card: updatedCard });
  } catch (err) {
    console.error("PATCH /api/cards/:id/move error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ─── DELETE /api/cards/:id ───────────────────────────────────────
app.delete("/api/cards/:id", async (req, res) => {
  try {
    const db = await getDb();
    const cardId = req.params.id;

    const { rows } = await db.query(
      "SELECT id, column_id FROM cards WHERE id = $1",
      [cardId]
    );
    if (rows.length === 0) {
      return res.status(404).json({ error: "Card not found" });
    }

    await db.query("DELETE FROM cards WHERE id = $1", [cardId]);

    broadcast("card-deleted", { cardId, columnId: rows[0].column_id });
    res.json({ ok: true });
  } catch (err) {
    console.error("DELETE /api/cards/:id error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ─── Start server ────────────────────────────────────────────────
async function start() {
  await getDb();
  console.log("Database initialized");
  app.listen(PORT, () => {
    console.log(`Kanban backend listening on http://localhost:${PORT}`);
  });
}

start().catch((err) => {
  console.error("Failed to start server:", err);
  process.exit(1);
});
