const express = require("express");
const crypto = require("crypto");
const { getDb } = require("../db");
const { broadcast } = require("../sse");

const router = express.Router();

// Gap used when placing a card at the end of a column
const POSITION_GAP = 1000;
// Minimum gap before renormalization is triggered
const MIN_GAP = 0.001;

/**
 * Generate a unique card id.
 */
function generateId() {
  return "card-" + crypto.randomUUID();
}

/**
 * Renormalize all card positions in a column to evenly spaced integers.
 * Returns the array of updated cards (with new positions).
 */
async function renormalizeColumn(db, columnId) {
  const { rows: cards } = await db.query(
    "SELECT id, position FROM cards WHERE column_id = $1 ORDER BY position ASC",
    [columnId]
  );

  const updated = [];
  for (let i = 0; i < cards.length; i++) {
    const newPos = (i + 1) * POSITION_GAP;
    if (cards[i].position !== newPos) {
      await db.query("UPDATE cards SET position = $1 WHERE id = $2", [
        newPos,
        cards[i].id,
      ]);
      updated.push({ id: cards[i].id, position: newPos });
    }
  }
  return updated;
}

/**
 * POST /api/cards
 * Body: { columnId, text }
 * Creates a card at the bottom of the specified column.
 */
router.post("/cards", async (req, res, next) => {
  try {
    const db = await getDb();
    const { columnId, text } = req.body;

    if (!columnId || !text || !text.trim()) {
      return res.status(400).json({ error: "columnId and text are required" });
    }

    // Check column exists
    const { rows: cols } = await db.query(
      "SELECT id FROM columns WHERE id = $1",
      [columnId]
    );
    if (cols.length === 0) {
      return res.status(404).json({ error: "Column not found" });
    }

    // Get the current max position in the column
    const { rows: maxRows } = await db.query(
      "SELECT COALESCE(MAX(position), 0) as max_pos FROM cards WHERE column_id = $1",
      [columnId]
    );
    const newPosition = parseFloat(maxRows[0].max_pos) + POSITION_GAP;
    const id = generateId();

    const { rows: inserted } = await db.query(
      `INSERT INTO cards (id, column_id, text, position)
       VALUES ($1, $2, $3, $4)
       RETURNING id, column_id, text, position, created_at`,
      [id, columnId, text.trim(), newPosition]
    );

    const card = inserted[0];

    // Broadcast to all clients
    broadcast("card:created", { card });

    res.status(201).json(card);
  } catch (err) {
    next(err);
  }
});

/**
 * PATCH /api/cards/:id/move
 * Body: { columnId, afterId?, beforeId? }
 *
 * Moves a card to the specified column. The card is placed:
 * - Between afterId and beforeId (if both provided)
 * - After afterId (if only afterId)
 * - Before beforeId (if only beforeId)
 * - At the end of the column (if neither)
 *
 * The server computes the new position, updates atomically, and broadcasts.
 */
router.patch("/cards/:id/move", async (req, res, next) => {
  try {
    const db = await getDb();
    const cardId = req.params.id;
    const { columnId, afterId, beforeId } = req.body;

    if (!columnId) {
      return res.status(400).json({ error: "columnId is required" });
    }

    // Verify card exists
    const { rows: cardRows } = await db.query(
      "SELECT id, column_id FROM cards WHERE id = $1",
      [cardId]
    );
    if (cardRows.length === 0) {
      return res.status(404).json({ error: "Card not found" });
    }

    const oldColumnId = cardRows[0].column_id;

    // Compute new position
    let newPosition;

    if (afterId && beforeId) {
      // Place between two cards
      const { rows: afterRows } = await db.query(
        "SELECT position FROM cards WHERE id = $1",
        [afterId]
      );
      const { rows: beforeRows } = await db.query(
        "SELECT position FROM cards WHERE id = $1",
        [beforeId]
      );
      if (afterRows.length > 0 && beforeRows.length > 0) {
        const afterPos = parseFloat(afterRows[0].position);
        const beforePos = parseFloat(beforeRows[0].position);
        newPosition = (afterPos + beforePos) / 2;
      } else {
        // Fallback: put at the end
        const { rows: maxRows } = await db.query(
          "SELECT COALESCE(MAX(position), 0) as max_pos FROM cards WHERE column_id = $1 AND id != $2",
          [columnId, cardId]
        );
        newPosition = parseFloat(maxRows[0].max_pos) + POSITION_GAP;
      }
    } else if (afterId) {
      // Place after a specific card
      const { rows: afterRows } = await db.query(
        "SELECT position FROM cards WHERE id = $1",
        [afterId]
      );
      if (afterRows.length > 0) {
        const afterPos = parseFloat(afterRows[0].position);
        // Get the next card after afterId in the same column
        const { rows: nextRows } = await db.query(
          "SELECT position FROM cards WHERE column_id = $1 AND position > $2 AND id != $3 ORDER BY position ASC LIMIT 1",
          [columnId, afterPos, cardId]
        );
        if (nextRows.length > 0) {
          newPosition = (afterPos + parseFloat(nextRows[0].position)) / 2;
        } else {
          newPosition = afterPos + POSITION_GAP;
        }
      } else {
        const { rows: maxRows } = await db.query(
          "SELECT COALESCE(MAX(position), 0) as max_pos FROM cards WHERE column_id = $1 AND id != $2",
          [columnId, cardId]
        );
        newPosition = parseFloat(maxRows[0].max_pos) + POSITION_GAP;
      }
    } else if (beforeId) {
      // Place before a specific card
      const { rows: beforeRows } = await db.query(
        "SELECT position FROM cards WHERE id = $1",
        [beforeId]
      );
      if (beforeRows.length > 0) {
        const beforePos = parseFloat(beforeRows[0].position);
        // Get the previous card before beforeId in the same column
        const { rows: prevRows } = await db.query(
          "SELECT position FROM cards WHERE column_id = $1 AND position < $2 AND id != $3 ORDER BY position DESC LIMIT 1",
          [columnId, beforePos, cardId]
        );
        if (prevRows.length > 0) {
          newPosition = (parseFloat(prevRows[0].position) + beforePos) / 2;
        } else {
          newPosition = beforePos / 2;
        }
      } else {
        const { rows: maxRows } = await db.query(
          "SELECT COALESCE(MAX(position), 0) as max_pos FROM cards WHERE column_id = $1 AND id != $2",
          [columnId, cardId]
        );
        newPosition = parseFloat(maxRows[0].max_pos) + POSITION_GAP;
      }
    } else {
      // No reference cards; place at the end
      const { rows: maxRows } = await db.query(
        "SELECT COALESCE(MAX(position), 0) as max_pos FROM cards WHERE column_id = $1 AND id != $2",
        [columnId, cardId]
      );
      newPosition = parseFloat(maxRows[0].max_pos) + POSITION_GAP;
    }

    // Atomic update: set position and column_id
    const { rows: updated } = await db.query(
      `UPDATE cards SET column_id = $1, position = $2
       WHERE id = $3
       RETURNING id, column_id, text, position, created_at`,
      [columnId, newPosition, cardId]
    );

    const card = updated[0];

    // Check if renormalization is needed in the target column
    let renormalized = false;
    const { rows: neighbors } = await db.query(
      `SELECT id, position FROM cards WHERE column_id = $1 ORDER BY position ASC`,
      [columnId]
    );

    let needsRenorm = false;
    for (let i = 1; i < neighbors.length; i++) {
      const gap = parseFloat(neighbors[i].position) - parseFloat(neighbors[i - 1].position);
      if (gap < MIN_GAP) {
        needsRenorm = true;
        break;
      }
    }

    if (needsRenorm) {
      await renormalizeColumn(db, columnId);
      renormalized = true;
    }

    // Also renormalize old column if it differs and may need it
    if (oldColumnId !== columnId) {
      const { rows: oldNeighbors } = await db.query(
        `SELECT id, position FROM cards WHERE column_id = $1 ORDER BY position ASC`,
        [oldColumnId]
      );
      let oldNeedsRenorm = false;
      for (let i = 1; i < oldNeighbors.length; i++) {
        const gap = parseFloat(oldNeighbors[i].position) - parseFloat(oldNeighbors[i - 1].position);
        if (gap < MIN_GAP) {
          oldNeedsRenorm = true;
          break;
        }
      }
      if (oldNeedsRenorm) {
        await renormalizeColumn(db, oldColumnId);
        renormalized = true;
      }
    }

    if (renormalized) {
      // Broadcast a full board sync to ensure all clients converge
      const { rows: allColumns } = await db.query(
        "SELECT id, title, position FROM columns ORDER BY position ASC"
      );
      const { rows: allCards } = await db.query(
        "SELECT id, column_id, text, position, created_at FROM cards ORDER BY position ASC"
      );
      const cardsByColumn = {};
      for (const col of allColumns) {
        cardsByColumn[col.id] = [];
      }
      for (const c of allCards) {
        if (cardsByColumn[c.column_id]) {
          cardsByColumn[c.column_id].push(c);
        }
      }
      const board = allColumns.map((col) => ({
        id: col.id,
        title: col.title,
        position: col.position,
        cards: cardsByColumn[col.id] || [],
      }));

      broadcast("board:sync", { board });
    } else {
      // Broadcast the move event with canonical card state
      broadcast("card:moved", {
        card,
        oldColumnId,
      });
    }

    // Return the most up-to-date card (may have been renormalized)
    if (renormalized) {
      const { rows: refreshed } = await db.query(
        "SELECT id, column_id, text, position, created_at FROM cards WHERE id = $1",
        [cardId]
      );
      res.json(refreshed[0]);
    } else {
      res.json(card);
    }
  } catch (err) {
    next(err);
  }
});

/**
 * DELETE /api/cards/:id
 * Deletes a card.
 */
router.delete("/cards/:id", async (req, res, next) => {
  try {
    const db = await getDb();
    const cardId = req.params.id;

    const { rows } = await db.query(
      "DELETE FROM cards WHERE id = $1 RETURNING id, column_id",
      [cardId]
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: "Card not found" });
    }

    broadcast("card:deleted", { cardId, columnId: rows[0].column_id });

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
