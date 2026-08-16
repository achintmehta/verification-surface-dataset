import { Router } from "express";
import { getDb } from "./db.js";
import { addClient, broadcast } from "./sse.js";
import crypto from "crypto";

const router = Router();

// ─── SSE Stream ───────────────────────────────────────────────────────────────
router.get("/stream", (req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.write(`event: connected\ndata: {}\n\n`);
  addClient(res);

  // Keep-alive every 15s
  const keepAlive = setInterval(() => {
    res.write(`:keepalive\n\n`);
  }, 15000);
  req.on("close", () => clearInterval(keepAlive));
});

// ─── GET /board ──────────────────────────────────────────────────────────────
router.get("/board", async (_req, res) => {
  try {
    const db = await getDb();
    const columns = await db.query("SELECT * FROM columns ORDER BY position ASC");
    const cards = await db.query("SELECT * FROM cards ORDER BY position ASC");

    const cardsByColumn = {};
    for (const col of columns.rows) {
      cardsByColumn[col.id] = [];
    }
    for (const card of cards.rows) {
      if (cardsByColumn[card.column_id]) {
        cardsByColumn[card.column_id].push(card);
      }
    }

    const board = columns.rows.map((col) => ({
      id: col.id,
      title: col.title,
      position: col.position,
      cards: cardsByColumn[col.id] || [],
    }));

    res.json(board);
  } catch (err) {
    console.error("GET /board error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /cards ─────────────────────────────────────────────────────────────
router.post("/cards", async (req, res) => {
  try {
    const db = await getDb();
    const { columnId, text } = req.body;

    if (!columnId || !text || !text.trim()) {
      return res.status(400).json({ error: "columnId and text are required" });
    }

    // Verify column exists
    const colResult = await db.query("SELECT id FROM columns WHERE id = $1", [columnId]);
    if (colResult.rows.length === 0) {
      return res.status(404).json({ error: "Column not found" });
    }

    // Get max position in column to append at end
    const maxPos = await db.query(
      "SELECT COALESCE(MAX(position), 0) as max_pos FROM cards WHERE column_id = $1",
      [columnId]
    );
    const newPosition = parseFloat(maxPos.rows[0].max_pos) + 1000;

    const id = `card-${crypto.randomUUID()}`;
    const result = await db.query(
      `INSERT INTO cards (id, column_id, text, position)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [id, columnId, text.trim(), newPosition]
    );

    const card = result.rows[0];

    // Broadcast to all clients
    broadcast("card-created", { card });

    res.status(201).json(card);
  } catch (err) {
    console.error("POST /cards error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ─── PATCH /cards/:id/move ──────────────────────────────────────────────────
router.patch("/cards/:id/move", async (req, res) => {
  try {
    const db = await getDb();
    const { id } = req.params;
    const { columnId, afterId, beforeId } = req.body;

    if (!columnId) {
      return res.status(400).json({ error: "columnId is required" });
    }

    // Verify card exists
    const cardResult = await db.query("SELECT * FROM cards WHERE id = $1", [id]);
    if (cardResult.rows.length === 0) {
      return res.status(404).json({ error: "Card not found" });
    }

    const oldCard = cardResult.rows[0];
    const oldColumnId = oldCard.column_id;

    // Verify target column exists
    const colResult = await db.query("SELECT id FROM columns WHERE id = $1", [columnId]);
    if (colResult.rows.length === 0) {
      return res.status(404).json({ error: "Column not found" });
    }

    // Compute new position
    let newPosition = await computePosition(db, columnId, afterId, beforeId, id);

    // Perform atomic update
    await db.query(
      "UPDATE cards SET column_id = $1, position = $2 WHERE id = $3",
      [columnId, newPosition, id]
    );

    // Check if we need to renormalize
    const needsRenorm = await checkAndRenormalize(db, columnId);

    // Re-fetch the card
    const updatedResult = await db.query("SELECT * FROM cards WHERE id = $1", [id]);
    const updatedCard = updatedResult.rows[0];

    if (needsRenorm) {
      // Broadcast entire column state for both affected columns
      const columnsToNorm = new Set([columnId]);
      if (oldColumnId !== columnId) columnsToNorm.add(oldColumnId);

      for (const cid of columnsToNorm) {
        const colCards = await db.query(
          "SELECT * FROM cards WHERE column_id = $1 ORDER BY position ASC",
          [cid]
        );
        broadcast("column-sync", { columnId: cid, cards: colCards.rows });
      }
    } else {
      broadcast("card-moved", {
        card: updatedCard,
        oldColumnId,
      });
    }

    res.json(updatedCard);
  } catch (err) {
    console.error("PATCH /cards/:id/move error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ─── DELETE /cards/:id ────────────────────────────────────────────────────────
router.delete("/cards/:id", async (req, res) => {
  try {
    const db = await getDb();
    const { id } = req.params;

    const cardResult = await db.query("SELECT * FROM cards WHERE id = $1", [id]);
    if (cardResult.rows.length === 0) {
      return res.status(404).json({ error: "Card not found" });
    }

    const card = cardResult.rows[0];
    await db.query("DELETE FROM cards WHERE id = $1", [id]);

    broadcast("card-deleted", { cardId: id, columnId: card.column_id });

    res.json({ success: true });
  } catch (err) {
    console.error("DELETE /cards/:id error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ─── Helper: compute fractional position ──────────────────────────────────────
async function computePosition(db, columnId, afterId, beforeId, movingCardId) {
  let afterPos = null;
  let beforePos = null;

  if (afterId) {
    const r = await db.query("SELECT position FROM cards WHERE id = $1", [afterId]);
    if (r.rows.length > 0) afterPos = parseFloat(r.rows[0].position);
  }

  if (beforeId) {
    const r = await db.query("SELECT position FROM cards WHERE id = $1", [beforeId]);
    if (r.rows.length > 0) beforePos = parseFloat(r.rows[0].position);
  }

  if (afterPos !== null && beforePos !== null) {
    // Insert between afterId and beforeId
    return (afterPos + beforePos) / 2;
  } else if (afterPos !== null) {
    // After afterId (at end of that section)
    // Find the next card after afterId in the same column
    const r = await db.query(
      "SELECT position FROM cards WHERE column_id = $1 AND position > $2 AND id != $3 ORDER BY position ASC LIMIT 1",
      [columnId, afterPos, movingCardId]
    );
    if (r.rows.length > 0) {
      return (afterPos + parseFloat(r.rows[0].position)) / 2;
    }
    return afterPos + 1000;
  } else if (beforePos !== null) {
    // Before beforeId (at start of that section)
    const r = await db.query(
      "SELECT position FROM cards WHERE column_id = $1 AND position < $2 AND id != $3 ORDER BY position DESC LIMIT 1",
      [columnId, beforePos, movingCardId]
    );
    if (r.rows.length > 0) {
      return (parseFloat(r.rows[0].position) + beforePos) / 2;
    }
    return beforePos / 2;
  } else {
    // No reference points; place at end of column
    const r = await db.query(
      "SELECT COALESCE(MAX(position), 0) as max_pos FROM cards WHERE column_id = $1 AND id != $2",
      [columnId, movingCardId]
    );
    return parseFloat(r.rows[0].max_pos) + 1000;
  }
}

// ─── Helper: check and renormalize positions if needed ────────────────────────
const MIN_GAP = 0.001;

async function checkAndRenormalize(db, columnId) {
  const cards = await db.query(
    "SELECT id, position FROM cards WHERE column_id = $1 ORDER BY position ASC",
    [columnId]
  );

  if (cards.rows.length < 2) return false;

  let needsRenorm = false;
  for (let i = 1; i < cards.rows.length; i++) {
    const gap = parseFloat(cards.rows[i].position) - parseFloat(cards.rows[i - 1].position);
    if (gap < MIN_GAP) {
      needsRenorm = true;
      break;
    }
  }

  if (!needsRenorm) return false;

  // Renormalize: spread cards evenly with gap of 1000
  for (let i = 0; i < cards.rows.length; i++) {
    const newPos = (i + 1) * 1000;
    await db.query("UPDATE cards SET position = $1 WHERE id = $2", [newPos, cards.rows[i].id]);
  }

  return true;
}

export default router;
