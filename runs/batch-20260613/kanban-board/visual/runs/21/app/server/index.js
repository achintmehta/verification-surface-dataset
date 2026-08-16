import express from "express";
import cors from "cors";
import crypto from "crypto";
import path from "path";
import { fileURLToPath } from "url";
import { getDb } from "./db.js";
import { addClient, broadcast } from "./sse.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Serve static frontend files
app.use(express.static(path.join(__dirname, "..", "client")));

// ─── SSE Endpoint ───────────────────────────────────────────────────────────
app.get("/api/stream", (req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.write(":ok\n\n");
  addClient(res);
});

// ─── GET /api/board ─────────────────────────────────────────────────────────
app.get("/api/board", async (req, res) => {
  try {
    const db = await getDb();
    const { rows: columns } = await db.query(
      "SELECT id, title, position FROM columns ORDER BY position ASC"
    );
    const { rows: cards } = await db.query(
      "SELECT id, column_id, text, position, created_at FROM cards ORDER BY position ASC"
    );

    const cardsByColumn = {};
    for (const col of columns) {
      cardsByColumn[col.id] = [];
    }
    for (const card of cards) {
      if (cardsByColumn[card.column_id]) {
        cardsByColumn[card.column_id].push(card);
      }
    }

    const result = columns.map((col) => ({
      ...col,
      cards: cardsByColumn[col.id] || [],
    }));

    res.json(result);
  } catch (err) {
    console.error("GET /api/board error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/cards ────────────────────────────────────────────────────────
app.post("/api/cards", async (req, res) => {
  try {
    const { columnId, text } = req.body;
    if (!columnId || !text || !text.trim()) {
      return res.status(400).json({ error: "columnId and text are required" });
    }

    const db = await getDb();
    const id = "card-" + crypto.randomUUID();

    // Find max position in the column, default 0
    const { rows: maxRows } = await db.query(
      "SELECT COALESCE(MAX(position), 0) as max_pos FROM cards WHERE column_id = $1",
      [columnId]
    );
    const position = maxRows[0].max_pos + 1000;

    const { rows } = await db.query(
      `INSERT INTO cards (id, column_id, text, position)
       VALUES ($1, $2, $3, $4)
       RETURNING id, column_id, text, position, created_at`,
      [id, columnId, text.trim(), position]
    );

    const card = rows[0];
    broadcast("card-created", { card });
    res.status(201).json(card);
  } catch (err) {
    console.error("POST /api/cards error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ─── Compute position between two reference positions ───────────────────────
function computePosition(afterPos, beforePos) {
  if (afterPos != null && beforePos != null) {
    return (afterPos + beforePos) / 2;
  }
  if (afterPos != null) {
    return afterPos + 1000;
  }
  if (beforePos != null) {
    return beforePos / 2;
  }
  return 1000;
}

// ─── Renormalize column positions ───────────────────────────────────────────
async function renormalizeColumn(db, columnId) {
  const { rows: cards } = await db.query(
    "SELECT id, position FROM cards WHERE column_id = $1 ORDER BY position ASC",
    [columnId]
  );

  const updates = [];
  for (let i = 0; i < cards.length; i++) {
    const newPos = (i + 1) * 1000;
    if (cards[i].position !== newPos) {
      updates.push({ id: cards[i].id, position: newPos });
    }
  }

  for (const u of updates) {
    await db.query("UPDATE cards SET position = $1 WHERE id = $2", [
      u.position,
      u.id,
    ]);
  }

  return updates.length > 0;
}

// ─── Check if renormalization is needed (collision or precision) ────────────
function needsRenormalization(positions) {
  if (positions.length < 2) return false;
  for (let i = 1; i < positions.length; i++) {
    const diff = Math.abs(positions[i] - positions[i - 1]);
    // If the gap is vanishingly small, we risk precision issues
    if (diff < 1e-10) return true;
  }
  return false;
}

// ─── PATCH /api/cards/:id/move ──────────────────────────────────────────────
app.patch("/api/cards/:id/move", async (req, res) => {
  try {
    const { id } = req.params;
    const { columnId, afterId, beforeId } = req.body;

    if (!columnId) {
      return res.status(400).json({ error: "columnId is required" });
    }

    const db = await getDb();

    // Check card exists
    const { rows: existing } = await db.query(
      "SELECT id, column_id FROM cards WHERE id = $1",
      [id]
    );
    if (existing.length === 0) {
      return res.status(404).json({ error: "Card not found" });
    }

    const oldColumnId = existing[0].column_id;

    // Get after/before positions
    let afterPos = null;
    let beforePos = null;

    if (afterId) {
      const { rows } = await db.query(
        "SELECT position FROM cards WHERE id = $1 AND column_id = $2",
        [afterId, columnId]
      );
      if (rows.length > 0) afterPos = rows[0].position;
    }

    if (beforeId) {
      const { rows } = await db.query(
        "SELECT position FROM cards WHERE id = $1 AND column_id = $2",
        [beforeId, columnId]
      );
      if (rows.length > 0) beforePos = rows[0].position;
    }

    // If inserting at the end (no beforeId) and no afterId, put at end of column
    if (afterPos == null && beforePos == null) {
      // Check if inserting at end
      if (!afterId && !beforeId) {
        const { rows: maxRows } = await db.query(
          "SELECT COALESCE(MAX(position), 0) as max_pos FROM cards WHERE column_id = $1 AND id != $2",
          [columnId, id]
        );
        afterPos = maxRows[0].max_pos > 0 ? maxRows[0].max_pos : null;
      }
    }

    const newPosition = computePosition(afterPos, beforePos);

    // Atomic update
    await db.query(
      "UPDATE cards SET column_id = $1, position = $2 WHERE id = $3",
      [columnId, newPosition, id]
    );

    // Check if renormalization is needed for the target column
    const { rows: colCards } = await db.query(
      "SELECT position FROM cards WHERE column_id = $1 ORDER BY position ASC",
      [columnId]
    );
    const positions = colCards.map((c) => c.position);

    let renormalized = false;
    if (needsRenormalization(positions)) {
      await renormalizeColumn(db, columnId);
      renormalized = true;
    }

    // Also renormalize old column if it changed and needed
    if (oldColumnId !== columnId) {
      const { rows: oldColCards } = await db.query(
        "SELECT position FROM cards WHERE column_id = $1 ORDER BY position ASC",
        [oldColumnId]
      );
      if (needsRenormalization(oldColCards.map((c) => c.position))) {
        await renormalizeColumn(db, oldColumnId);
      }
    }

    // Fetch the final card state
    const { rows: updatedRows } = await db.query(
      "SELECT id, column_id, text, position, created_at FROM cards WHERE id = $1",
      [id]
    );
    const card = updatedRows[0];

    if (renormalized) {
      // Broadcast a full column refresh for the affected column
      const { rows: fullCol } = await db.query(
        "SELECT id, column_id, text, position, created_at FROM cards WHERE column_id = $1 ORDER BY position ASC",
        [columnId]
      );
      broadcast("column-refreshed", { columnId, cards: fullCol });
      if (oldColumnId !== columnId) {
        broadcast("card-moved", { card, oldColumnId });
      }
    } else {
      broadcast("card-moved", { card, oldColumnId });
    }

    res.json(card);
  } catch (err) {
    console.error("PATCH /api/cards/:id/move error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ─── DELETE /api/cards/:id ──────────────────────────────────────────────────
app.delete("/api/cards/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const db = await getDb();

    const { rows } = await db.query(
      "SELECT id, column_id FROM cards WHERE id = $1",
      [id]
    );
    if (rows.length === 0) {
      return res.status(404).json({ error: "Card not found" });
    }

    await db.query("DELETE FROM cards WHERE id = $1", [id]);
    broadcast("card-deleted", { id, columnId: rows[0].column_id });
    res.json({ ok: true });
  } catch (err) {
    console.error("DELETE /api/cards/:id error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ─── Start ──────────────────────────────────────────────────────────────────
async function start() {
  await getDb(); // Initialize DB on startup
  app.listen(PORT, () => {
    console.log(`Kanban backend listening on http://localhost:${PORT}`);
  });
}

start().catch(console.error);
