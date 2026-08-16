import { Router } from "express";
import { getDb } from "./db.js";
import { addClient, broadcast } from "./sse.js";

const router = Router();

// ─── Helpers ────────────────────────────────────────────────────────────────

const POSITION_GAP = 1000;
const MIN_GAP = 0.001; // below this, renormalize

/**
 * Renormalize positions for all cards in a column. Broadcasts a
 * "renormalize" event so every client snaps to the corrected order.
 */
async function renormalizeColumn(db, columnId) {
  const { rows: cards } = await db.query(
    "SELECT id FROM cards WHERE column_id = $1 ORDER BY position ASC, created_at ASC",
    [columnId]
  );
  for (let i = 0; i < cards.length; i++) {
    const newPos = (i + 1) * POSITION_GAP;
    await db.query("UPDATE cards SET position = $1 WHERE id = $2", [newPos, cards[i].id]);
  }
  // Fetch the full column state after renormalization
  const { rows: updated } = await db.query(
    "SELECT id, column_id, text, position, created_at FROM cards WHERE column_id = $1 ORDER BY position ASC",
    [columnId]
  );
  broadcast("renormalize", { columnId, cards: updated });
}

/**
 * Compute a position value between two existing positions.
 * Returns null if the gap is too small (needs renormalization).
 */
function midpoint(before, after) {
  const mid = (before + after) / 2;
  if (Math.abs(after - before) < MIN_GAP || mid === before || mid === after) {
    return null; // precision exhaustion
  }
  return mid;
}

// ─── GET /api/board ─────────────────────────────────────────────────────────

router.get("/api/board", async (_req, res) => {
  try {
    const db = await getDb();
    const { rows: columns } = await db.query(
      "SELECT id, title, position FROM columns ORDER BY position ASC"
    );
    const { rows: cards } = await db.query(
      "SELECT id, column_id, text, position, created_at FROM cards ORDER BY position ASC"
    );

    // Group cards into columns
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

    res.json(board);
  } catch (err) {
    console.error("GET /api/board error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ─── POST /api/cards ────────────────────────────────────────────────────────

router.post("/api/cards", async (req, res) => {
  try {
    const db = await getDb();
    const { columnId, text } = req.body;

    if (!columnId || !text || !text.trim()) {
      return res.status(400).json({ error: "columnId and text are required" });
    }

    // Verify column exists
    const { rows: colRows } = await db.query("SELECT id FROM columns WHERE id = $1", [columnId]);
    if (colRows.length === 0) {
      return res.status(404).json({ error: "Column not found" });
    }

    // Get the max position in the column
    const { rows: maxRows } = await db.query(
      "SELECT COALESCE(MAX(position), 0) AS max_pos FROM cards WHERE column_id = $1",
      [columnId]
    );
    const newPosition = maxRows[0].max_pos + POSITION_GAP;

    const { rows } = await db.query(
      `INSERT INTO cards (column_id, text, position)
       VALUES ($1, $2, $3)
       RETURNING id, column_id, text, position, created_at`,
      [columnId, text.trim(), newPosition]
    );

    const card = rows[0];
    broadcast("card_created", card);
    res.status(201).json(card);
  } catch (err) {
    console.error("POST /api/cards error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ─── PATCH /api/cards/:id/move ──────────────────────────────────────────────

router.patch("/api/cards/:id/move", async (req, res) => {
  try {
    const db = await getDb();
    const { id } = req.params;
    const { columnId, afterId, beforeId } = req.body;

    if (!columnId) {
      return res.status(400).json({ error: "columnId is required" });
    }

    // Verify card exists
    const { rows: cardRows } = await db.query(
      "SELECT id, column_id FROM cards WHERE id = $1",
      [id]
    );
    if (cardRows.length === 0) {
      return res.status(404).json({ error: "Card not found" });
    }

    const oldColumnId = cardRows[0].column_id;

    // Compute the new position
    let newPosition;
    let needsRenormalize = false;

    if (afterId && beforeId) {
      // Insert between two cards
      const { rows: afterRows } = await db.query(
        "SELECT position FROM cards WHERE id = $1", [afterId]
      );
      const { rows: beforeRows } = await db.query(
        "SELECT position FROM cards WHERE id = $1", [beforeId]
      );
      if (afterRows.length === 0 || beforeRows.length === 0) {
        return res.status(400).json({ error: "afterId or beforeId not found" });
      }
      const afterPos = afterRows[0].position;
      const beforePos = beforeRows[0].position;
      const mid = midpoint(afterPos, beforePos);
      if (mid === null) {
        needsRenormalize = true;
        newPosition = (afterPos + beforePos) / 2; // use imprecise for now, then renormalize
      } else {
        newPosition = mid;
      }
    } else if (afterId) {
      // Insert after a card (at the end)
      const { rows: afterRows } = await db.query(
        "SELECT position FROM cards WHERE id = $1", [afterId]
      );
      if (afterRows.length === 0) {
        return res.status(400).json({ error: "afterId not found" });
      }
      newPosition = afterRows[0].position + POSITION_GAP;
    } else if (beforeId) {
      // Insert before a card (at the beginning)
      const { rows: beforeRows } = await db.query(
        "SELECT position FROM cards WHERE id = $1", [beforeId]
      );
      if (beforeRows.length === 0) {
        return res.status(400).json({ error: "beforeId not found" });
      }
      newPosition = beforeRows[0].position / 2;
      if (newPosition < MIN_GAP) {
        needsRenormalize = true;
      }
    } else {
      // No neighbors → first card in the column (or only card)
      const { rows: existing } = await db.query(
        "SELECT COALESCE(MAX(position), 0) AS max_pos FROM cards WHERE column_id = $1 AND id != $2",
        [columnId, id]
      );
      newPosition = existing[0].max_pos + POSITION_GAP;
    }

    // Atomic update
    await db.query(
      "UPDATE cards SET column_id = $1, position = $2 WHERE id = $3",
      [columnId, newPosition, id]
    );

    // Check for position collision
    const { rows: collisionCheck } = await db.query(
      "SELECT COUNT(*)::int AS cnt FROM cards WHERE column_id = $1 AND position = $2",
      [columnId, newPosition]
    );
    if (collisionCheck[0].cnt > 1) {
      needsRenormalize = true;
    }

    // Fetch the updated card
    const { rows: updatedRows } = await db.query(
      "SELECT id, column_id, text, position, created_at FROM cards WHERE id = $1",
      [id]
    );
    const updatedCard = updatedRows[0];

    // Broadcast the move
    broadcast("card_moved", {
      card: updatedCard,
      oldColumnId,
    });

    // If old column is different, we may want to broadcast both columns
    if (needsRenormalize) {
      await renormalizeColumn(db, columnId);
      if (oldColumnId !== columnId) {
        await renormalizeColumn(db, oldColumnId);
      }
    }

    res.json(updatedCard);
  } catch (err) {
    console.error("PATCH /api/cards/:id/move error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ─── DELETE /api/cards/:id ──────────────────────────────────────────────────

router.delete("/api/cards/:id", async (req, res) => {
  try {
    const db = await getDb();
    const { id } = req.params;

    const { rows } = await db.query(
      "DELETE FROM cards WHERE id = $1 RETURNING id, column_id",
      [id]
    );
    if (rows.length === 0) {
      return res.status(404).json({ error: "Card not found" });
    }

    broadcast("card_deleted", { id: rows[0].id, columnId: rows[0].column_id });
    res.json({ ok: true });
  } catch (err) {
    console.error("DELETE /api/cards/:id error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ─── SSE /api/stream ────────────────────────────────────────────────────────

router.get("/api/stream", (req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });

  // Send initial heartbeat
  res.write(":ok\n\n");

  addClient(res);

  // Keep alive every 15s
  const heartbeat = setInterval(() => {
    res.write(":heartbeat\n\n");
  }, 15000);

  req.on("close", () => {
    clearInterval(heartbeat);
  });
});

export default router;
