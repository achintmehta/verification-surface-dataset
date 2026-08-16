import { Router } from "express";
import { getDb } from "./db.js";
import { addClient, broadcast } from "./sse.js";
import {
  computePosition,
  needsRenormalization,
  renormalizeColumn,
  DEFAULT_GAP,
} from "./ordering.js";
import crypto from "crypto";

const router = Router();

// ---------------------------------------------------------------------------
// SSE stream
// ---------------------------------------------------------------------------
router.get("/stream", (req, res) => {
  addClient(req, res);
});

// ---------------------------------------------------------------------------
// GET /board – full board state
// ---------------------------------------------------------------------------
router.get("/board", async (_req, res) => {
  try {
    const db = await getDb();
    const { rows: columns } = await db.query(
      "SELECT id, title, position FROM columns ORDER BY position"
    );
    const { rows: cards } = await db.query(
      "SELECT id, column_id, text, position, created_at FROM cards ORDER BY position, created_at"
    );

    // Group cards by column
    /** @type {Record<string, typeof cards>} */
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
    console.error("GET /board error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ---------------------------------------------------------------------------
// POST /cards – create a card
// ---------------------------------------------------------------------------
router.post("/cards", async (req, res) => {
  try {
    const { columnId, text } = req.body;
    if (!columnId || !text) {
      return res.status(400).json({ error: "columnId and text are required" });
    }
    const db = await getDb();

    // Determine position: after the last card in the column
    const { rows: lastRows } = await db.query(
      "SELECT MAX(position) AS max_pos FROM cards WHERE column_id = $1",
      [columnId]
    );
    const lastPos = lastRows[0]?.max_pos;
    const position = lastPos != null ? lastPos + DEFAULT_GAP : DEFAULT_GAP;

    const id = `card-${crypto.randomUUID()}`;
    const { rows } = await db.query(
      `INSERT INTO cards (id, column_id, text, position)
       VALUES ($1, $2, $3, $4)
       RETURNING id, column_id, text, position, created_at`,
      [id, columnId, text, position]
    );

    const card = rows[0];
    broadcast("card-created", card);
    res.status(201).json(card);
  } catch (err) {
    console.error("POST /cards error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ---------------------------------------------------------------------------
// PATCH /cards/:id/move – move / reorder a card
// Body: { columnId, afterId?, beforeId? }
//   afterId  = the card that should appear BEFORE this one in the list (lower position)
//   beforeId = the card that should appear AFTER this one in the list (higher position)
// ---------------------------------------------------------------------------
router.patch("/cards/:id/move", async (req, res) => {
  try {
    const { id } = req.params;
    const { columnId, afterId, beforeId } = req.body;
    if (!columnId) {
      return res.status(400).json({ error: "columnId is required" });
    }

    const db = await getDb();

    // --- Begin transaction ---
    await db.exec("BEGIN");

    try {
      // Verify card exists
      const { rows: cardRows } = await db.query(
        "SELECT id, column_id FROM cards WHERE id = $1",
        [id]
      );
      if (cardRows.length === 0) {
        await db.exec("ROLLBACK");
        return res.status(404).json({ error: "Card not found" });
      }

      const oldColumnId = cardRows[0].column_id;

      // Get neighbour positions
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

      // If neither neighbour is specified, figure out placement
      if (!afterId && !beforeId) {
        // Move to end of target column
        const { rows: maxRows } = await db.query(
          "SELECT MAX(position) AS max_pos FROM cards WHERE column_id = $1 AND id != $2",
          [columnId, id]
        );
        afterPos = maxRows[0]?.max_pos ?? null;
      } else if (afterId && !beforeId) {
        // afterId provided but no beforeId – place right after afterId
        // find the next card after afterId
        if (afterPos != null) {
          const { rows: nextRows } = await db.query(
            `SELECT position FROM cards
             WHERE column_id = $1 AND position > $2 AND id != $3
             ORDER BY position LIMIT 1`,
            [columnId, afterPos, id]
          );
          if (nextRows.length > 0) beforePos = nextRows[0].position;
        }
      } else if (!afterId && beforeId) {
        // beforeId provided but no afterId – place right before beforeId
        if (beforePos != null) {
          const { rows: prevRows } = await db.query(
            `SELECT position FROM cards
             WHERE column_id = $1 AND position < $2 AND id != $3
             ORDER BY position DESC LIMIT 1`,
            [columnId, beforePos, id]
          );
          if (prevRows.length > 0) afterPos = prevRows[0].position;
        }
      }

      const newPosition = computePosition(afterPos, beforePos);

      await db.query(
        "UPDATE cards SET column_id = $1, position = $2 WHERE id = $3",
        [columnId, newPosition, id]
      );

      // Check if renormalization is needed
      let renormalized = false;
      /** @type {Array<{id: string, position: number}> | null} */
      let renormUpdates = null;
      if (needsRenormalization(newPosition, afterPos, beforePos)) {
        renormUpdates = await renormalizeColumn(db, columnId);
        renormalized = true;
      }

      await db.exec("COMMIT");

      // Fetch the canonical card state after commit
      const { rows: updatedRows } = await db.query(
        "SELECT id, column_id, text, position, created_at FROM cards WHERE id = $1",
        [id]
      );
      const updatedCard = updatedRows[0];

      // Broadcast
      broadcast("card-moved", {
        card: updatedCard,
        sourceColumnId: oldColumnId,
      });

      // If we renormalized, broadcast the full column ordering
      if (renormalized && renormUpdates) {
        const { rows: colCards } = await db.query(
          "SELECT id, column_id, text, position, created_at FROM cards WHERE column_id = $1 ORDER BY position",
          [columnId]
        );
        broadcast("column-renormalized", {
          columnId,
          cards: colCards,
        });
      }

      res.json(updatedCard);
    } catch (innerErr) {
      await db.exec("ROLLBACK");
      throw innerErr;
    }
  } catch (err) {
    console.error("PATCH /cards/:id/move error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ---------------------------------------------------------------------------
// DELETE /cards/:id – delete a card
// ---------------------------------------------------------------------------
router.delete("/cards/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const db = await getDb();
    const { rows } = await db.query(
      "DELETE FROM cards WHERE id = $1 RETURNING id, column_id",
      [id]
    );
    if (rows.length === 0) {
      return res.status(404).json({ error: "Card not found" });
    }
    broadcast("card-deleted", rows[0]);
    res.json(rows[0]);
  } catch (err) {
    console.error("DELETE /cards/:id error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
