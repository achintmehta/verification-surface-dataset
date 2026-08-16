const express = require("express");
const { getDb } = require("./db");
const { addClient, broadcast } = require("./sse");
const crypto = require("crypto");

const router = express.Router();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function generateId() {
  return crypto.randomUUID();
}

const POSITION_GAP = 1000; // default gap between positions
const MIN_GAP = 0.001; // threshold to trigger renormalization

/**
 * Compute a position between `before` and `after`.
 * - Both null → POSITION_GAP (first card)
 * - after null → before + POSITION_GAP  (append)
 * - before null → after / 2              (prepend)
 * - both set → (before + after) / 2      (insert between)
 */
function computePosition(afterPos, beforePos) {
  if (afterPos == null && beforePos == null) return POSITION_GAP;
  if (afterPos == null) return beforePos + POSITION_GAP;
  if (beforePos == null) return afterPos / 2;
  return (afterPos + beforePos) / 2;
}

/**
 * Renormalize all card positions in a column if any gap is smaller than MIN_GAP.
 * Returns true if renormalization occurred.
 */
async function renormalizeIfNeeded(db, columnId) {
  const { rows: cards } = await db.query(
    "SELECT id, position FROM cards WHERE column_id = $1 ORDER BY position ASC",
    [columnId]
  );
  if (cards.length < 2) return false;

  let needsRenorm = false;
  for (let i = 1; i < cards.length; i++) {
    if (cards[i].position - cards[i - 1].position < MIN_GAP) {
      needsRenorm = true;
      break;
    }
  }

  // Also check for exact duplicates
  const seen = new Set();
  for (const c of cards) {
    if (seen.has(c.position)) {
      needsRenorm = true;
      break;
    }
    seen.add(c.position);
  }

  if (!needsRenorm) return false;

  // Renormalize: spread cards evenly
  for (let i = 0; i < cards.length; i++) {
    const newPos = (i + 1) * POSITION_GAP;
    await db.query("UPDATE cards SET position = $1 WHERE id = $2", [newPos, cards[i].id]);
  }

  return true;
}

// ---------------------------------------------------------------------------
// GET /api/board — full board state
// ---------------------------------------------------------------------------
router.get("/board", async (_req, res) => {
  try {
    const db = await getDb();
    const { rows: columns } = await db.query(
      "SELECT id, title, position FROM columns ORDER BY position ASC"
    );
    const { rows: cards } = await db.query(
      "SELECT id, column_id, text, position, created_at FROM cards ORDER BY position ASC"
    );

    // Group cards by column
    const cardsByCol = {};
    for (const col of columns) {
      cardsByCol[col.id] = [];
    }
    for (const card of cards) {
      if (cardsByCol[card.column_id]) {
        cardsByCol[card.column_id].push(card);
      }
    }

    const board = columns.map((col) => ({
      id: col.id,
      title: col.title,
      position: col.position,
      cards: cardsByCol[col.id] || [],
    }));

    res.json(board);
  } catch (err) {
    console.error("GET /api/board error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ---------------------------------------------------------------------------
// POST /api/cards — create a new card
// ---------------------------------------------------------------------------
router.post("/cards", async (req, res) => {
  try {
    const { columnId, text } = req.body;
    if (!columnId || !text) {
      return res.status(400).json({ error: "columnId and text are required" });
    }

    const db = await getDb();

    // Verify column exists
    const { rows: cols } = await db.query("SELECT id FROM columns WHERE id = $1", [columnId]);
    if (cols.length === 0) {
      return res.status(404).json({ error: "Column not found" });
    }

    // Get the last card position in the column
    const { rows: lastCards } = await db.query(
      "SELECT position FROM cards WHERE column_id = $1 ORDER BY position DESC LIMIT 1",
      [columnId]
    );

    const lastPos = lastCards.length > 0 ? lastCards[0].position : 0;
    const newPos = lastPos + POSITION_GAP;
    const id = generateId();

    await db.query(
      "INSERT INTO cards (id, column_id, text, position) VALUES ($1, $2, $3, $4)",
      [id, columnId, text, newPos]
    );

    const { rows } = await db.query(
      "SELECT id, column_id, text, position, created_at FROM cards WHERE id = $1",
      [id]
    );
    const card = rows[0];

    broadcast("card:created", { card });
    res.status(201).json(card);
  } catch (err) {
    console.error("POST /api/cards error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ---------------------------------------------------------------------------
// PATCH /api/cards/:id/move — move/reorder a card
// ---------------------------------------------------------------------------
router.patch("/cards/:id/move", async (req, res) => {
  try {
    const { id } = req.params;
    const { columnId, afterId, beforeId } = req.body;

    if (!columnId) {
      return res.status(400).json({ error: "columnId is required" });
    }

    const db = await getDb();

    // Verify card exists
    const { rows: existing } = await db.query(
      "SELECT id, column_id, position FROM cards WHERE id = $1",
      [id]
    );
    if (existing.length === 0) {
      return res.status(404).json({ error: "Card not found" });
    }

    // Verify column exists
    const { rows: cols } = await db.query("SELECT id FROM columns WHERE id = $1", [columnId]);
    if (cols.length === 0) {
      return res.status(404).json({ error: "Column not found" });
    }

    // Look up positions of afterId and beforeId
    let afterPos = null;
    let beforePos = null;

    if (afterId) {
      const { rows } = await db.query(
        "SELECT position FROM cards WHERE id = $1",
        [afterId]
      );
      if (rows.length > 0) afterPos = rows[0].position;
    }

    if (beforeId) {
      const { rows } = await db.query(
        "SELECT position FROM cards WHERE id = $1",
        [beforeId]
      );
      if (rows.length > 0) beforePos = rows[0].position;
    }

    // Compute new position
    let newPos;
    if (afterPos == null && beforePos == null) {
      // Moving to an empty column or to end — put at end
      const { rows: lastCards } = await db.query(
        "SELECT position FROM cards WHERE column_id = $1 AND id != $2 ORDER BY position DESC LIMIT 1",
        [columnId, id]
      );
      const lastPos = lastCards.length > 0 ? lastCards[0].position : 0;
      newPos = lastPos + POSITION_GAP;
    } else {
      newPos = computePosition(afterPos, beforePos);
    }

    // Atomic update: column_id + position in single UPDATE
    await db.query(
      "UPDATE cards SET column_id = $1, position = $2 WHERE id = $3",
      [columnId, newPos, id]
    );

    // Check if renormalization is needed for the target column
    const renormalized = await renormalizeIfNeeded(db, columnId);

    // Also renormalize source column if it's different
    const sourceColumnId = existing[0].column_id;
    let sourceRenormalized = false;
    if (sourceColumnId !== columnId) {
      sourceRenormalized = await renormalizeIfNeeded(db, sourceColumnId);
    }

    // Fetch the canonical card state
    const { rows: updatedRows } = await db.query(
      "SELECT id, column_id, text, position, created_at FROM cards WHERE id = $1",
      [id]
    );
    const card = updatedRows[0];

    // If renormalization occurred, broadcast the full column(s) state
    if (renormalized || sourceRenormalized) {
      // Broadcast full board refresh
      const { rows: allColumns } = await db.query(
        "SELECT id, title, position FROM columns ORDER BY position ASC"
      );
      const { rows: allCards } = await db.query(
        "SELECT id, column_id, text, position, created_at FROM cards ORDER BY position ASC"
      );
      const cardsByCol = {};
      for (const col of allColumns) cardsByCol[col.id] = [];
      for (const c of allCards) {
        if (cardsByCol[c.column_id]) cardsByCol[c.column_id].push(c);
      }
      const board = allColumns.map((col) => ({
        id: col.id,
        title: col.title,
        position: col.position,
        cards: cardsByCol[col.id] || [],
      }));
      broadcast("board:refresh", { board });
    } else {
      broadcast("card:moved", {
        card,
        sourceColumnId,
      });
    }

    res.json(card);
  } catch (err) {
    console.error("PATCH /api/cards/:id/move error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ---------------------------------------------------------------------------
// DELETE /api/cards/:id — delete a card
// ---------------------------------------------------------------------------
router.delete("/cards/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const db = await getDb();

    const { rows } = await db.query("SELECT id, column_id FROM cards WHERE id = $1", [id]);
    if (rows.length === 0) {
      return res.status(404).json({ error: "Card not found" });
    }

    await db.query("DELETE FROM cards WHERE id = $1", [id]);

    broadcast("card:deleted", { cardId: id, columnId: rows[0].column_id });
    res.json({ ok: true });
  } catch (err) {
    console.error("DELETE /api/cards/:id error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ---------------------------------------------------------------------------
// GET /api/stream — SSE endpoint
// ---------------------------------------------------------------------------
router.get("/stream", (req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });

  // Send initial keepalive
  res.write(": connected\n\n");

  addClient(res);

  // Heartbeat every 30s
  const heartbeat = setInterval(() => {
    res.write(": heartbeat\n\n");
  }, 30000);

  req.on("close", () => {
    clearInterval(heartbeat);
  });
});

module.exports = router;
