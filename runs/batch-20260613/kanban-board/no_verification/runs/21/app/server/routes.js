const express = require("express");
const { getDb } = require("./db");
const { addClient, broadcast } = require("./sse");
const crypto = require("crypto");

const router = express.Router();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function genId() {
  return crypto.randomUUID();
}

const POSITION_GAP = 1000; // default gap between positions
const MIN_GAP = 0.0001; // threshold to trigger renormalization

/**
 * Compute a position value between `before` (lower) and `after` (upper).
 * Either may be null indicating start/end of list.
 */
function computePosition(before, after) {
  if (before == null && after == null) return POSITION_GAP;
  if (before == null) return after / 2;
  if (after == null) return before + POSITION_GAP;
  return (before + after) / 2;
}

/**
 * Renormalize positions of all cards in a column, evenly spaced.
 * Returns the list of affected cards if renormalization happened.
 */
async function renormalizeColumnIfNeeded(db, columnId) {
  const { rows: cards } = await db.query(
    "SELECT id, position FROM cards WHERE column_id = $1 ORDER BY position ASC",
    [columnId]
  );

  if (cards.length < 2) return null;

  // Check if any adjacent gap is below threshold
  let needsRenorm = false;
  for (let i = 1; i < cards.length; i++) {
    if (Math.abs(cards[i].position - cards[i - 1].position) < MIN_GAP) {
      needsRenorm = true;
      break;
    }
  }

  if (!needsRenorm) return null;

  // Renormalize
  const updatedCards = [];
  for (let i = 0; i < cards.length; i++) {
    const newPos = (i + 1) * POSITION_GAP;
    await db.query("UPDATE cards SET position = $1 WHERE id = $2", [
      newPos,
      cards[i].id,
    ]);
    updatedCards.push({ id: cards[i].id, position: newPos });
  }

  return updatedCards;
}

// ---------------------------------------------------------------------------
// GET /api/board – full board state
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
      id: col.id,
      title: col.title,
      position: col.position,
      cards: cardsByColumn[col.id] || [],
    }));

    res.json(result);
  } catch (err) {
    console.error("GET /api/board error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ---------------------------------------------------------------------------
// POST /api/cards – create a card at the end of a column
// ---------------------------------------------------------------------------
router.post("/cards", async (req, res) => {
  try {
    const { columnId, text } = req.body;
    if (!columnId || !text) {
      return res.status(400).json({ error: "columnId and text are required" });
    }

    const db = await getDb();

    // Verify column exists
    const { rows: colRows } = await db.query(
      "SELECT id FROM columns WHERE id = $1",
      [columnId]
    );
    if (colRows.length === 0) {
      return res.status(404).json({ error: "Column not found" });
    }

    // Get max position in column
    const { rows: maxRows } = await db.query(
      "SELECT MAX(position) AS max_pos FROM cards WHERE column_id = $1",
      [columnId]
    );
    const maxPos = maxRows[0].max_pos;
    const position = maxPos != null ? maxPos + POSITION_GAP : POSITION_GAP;

    const id = genId();
    const { rows: inserted } = await db.query(
      `INSERT INTO cards (id, column_id, text, position)
       VALUES ($1, $2, $3, $4)
       RETURNING id, column_id, text, position, created_at`,
      [id, columnId, text, position]
    );

    const card = inserted[0];

    broadcast("card:created", { card });

    res.status(201).json(card);
  } catch (err) {
    console.error("POST /api/cards error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ---------------------------------------------------------------------------
// PATCH /api/cards/:id/move – move / reorder a card
// Body: { columnId, afterId?, beforeId? }
//   afterId  = id of the card that should appear BEFORE this card (lower position)
//   beforeId = id of the card that should appear AFTER this card (higher position)
// ---------------------------------------------------------------------------
router.patch("/cards/:id/move", async (req, res) => {
  try {
    const { id } = req.params;
    const { columnId, afterId, beforeId } = req.body;

    if (!columnId) {
      return res.status(400).json({ error: "columnId is required" });
    }

    const db = await getDb();

    // Use a transaction for atomicity
    await db.exec("BEGIN");

    try {
      // Verify card exists
      const { rows: cardRows } = await db.query(
        "SELECT id, column_id, position FROM cards WHERE id = $1",
        [id]
      );
      if (cardRows.length === 0) {
        await db.exec("ROLLBACK");
        return res.status(404).json({ error: "Card not found" });
      }

      // Verify target column exists
      const { rows: colRows } = await db.query(
        "SELECT id FROM columns WHERE id = $1",
        [columnId]
      );
      if (colRows.length === 0) {
        await db.exec("ROLLBACK");
        return res.status(404).json({ error: "Column not found" });
      }

      // Resolve positions of neighbors
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

      // If neither neighbor found, figure out placement
      if (afterPos == null && beforePos == null) {
        // Place at end of column (but exclude the card being moved if it's in same column)
        const { rows: maxRows } = await db.query(
          "SELECT MAX(position) AS max_pos FROM cards WHERE column_id = $1 AND id != $2",
          [columnId, id]
        );
        const maxPos = maxRows[0].max_pos;
        afterPos = maxPos != null ? maxPos : null;
      }

      const newPosition = computePosition(afterPos, beforePos);

      // Atomic update: column_id + position in one statement
      await db.query(
        "UPDATE cards SET column_id = $1, position = $2 WHERE id = $3",
        [columnId, newPosition, id]
      );

      await db.exec("COMMIT");

      // Fetch the canonical card state
      const { rows: updatedRows } = await db.query(
        "SELECT id, column_id, text, position, created_at FROM cards WHERE id = $1",
        [id]
      );
      const card = updatedRows[0];

      // Check if renormalization is needed for the target column
      const renormalized = await renormalizeColumnIfNeeded(db, columnId);

      // Also check source column if it differs
      const oldColumnId = cardRows[0].column_id;
      let renormalizedSource = null;
      if (oldColumnId !== columnId) {
        renormalizedSource = await renormalizeColumnIfNeeded(db, oldColumnId);
      }

      // Broadcast the move event
      broadcast("card:moved", {
        card: renormalized
          ? {
              ...card,
              position: renormalized.find((c) => c.id === card.id)?.position ?? card.position,
            }
          : card,
        sourceColumnId: oldColumnId,
      });

      // If renormalization happened, broadcast it so all clients re-sync
      if (renormalized) {
        broadcast("column:renormalized", {
          columnId,
          cards: renormalized,
        });
      }
      if (renormalizedSource) {
        broadcast("column:renormalized", {
          columnId: oldColumnId,
          cards: renormalizedSource,
        });
      }

      // Re-fetch card after possible renorm
      const { rows: finalRows } = await db.query(
        "SELECT id, column_id, text, position, created_at FROM cards WHERE id = $1",
        [id]
      );

      res.json(finalRows[0]);
    } catch (innerErr) {
      await db.exec("ROLLBACK");
      throw innerErr;
    }
  } catch (err) {
    console.error("PATCH /api/cards/:id/move error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ---------------------------------------------------------------------------
// GET /api/stream – SSE endpoint
// ---------------------------------------------------------------------------
router.get("/stream", (req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });

  // Send a heartbeat comment immediately so the client knows the connection is alive
  res.write(":ok\n\n");

  addClient(res);

  // Keep-alive every 30 seconds
  const keepAlive = setInterval(() => {
    res.write(":ping\n\n");
  }, 30000);

  req.on("close", () => {
    clearInterval(keepAlive);
  });
});

module.exports = router;
