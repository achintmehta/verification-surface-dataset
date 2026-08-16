import { Router } from "express";
import { v4 as uuidv4 } from "./uuid.js";
import { getDb } from "./db.js";
import { addClient, broadcast } from "./sse.js";

const router = Router();

// Serialize mutations to avoid race conditions with PGLite (single-connection embedded DB)
let mutationQueue = Promise.resolve();

function enqueueMutation(fn) {
  const p = mutationQueue.then(fn, fn);
  mutationQueue = p.catch(() => {}); // prevent unhandled rejection chain
  return p;
}

// ─── SSE Stream ───────────────────────────────────────────────────────────────

router.get("/stream", (req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.write(":\n\n"); // comment to flush headers
  addClient(res);

  // Send keepalive every 15 seconds
  const keepalive = setInterval(() => {
    res.write(":\n\n");
  }, 15000);

  req.on("close", () => {
    clearInterval(keepalive);
  });
});

// ─── GET /board ───────────────────────────────────────────────────────────────

router.get("/board", async (_req, res) => {
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
        .sort((a, b) => a.position - b.position),
    }));

    res.json({ columns });
  } catch (err) {
    console.error("GET /board error:", err);
    res.status(500).json({ error: "Failed to load board" });
  }
});

// ─── POST /cards ──────────────────────────────────────────────────────────────

router.post("/cards", async (req, res) => {
  try {
    const result = await enqueueMutation(async () => {
      const db = await getDb();
      const { columnId, text } = req.body;

      if (!columnId || !text || !text.trim()) {
        return { error: "columnId and text are required", status: 400 };
      }

      // Get the max position in the column
      const maxResult = await db.query(
        "SELECT COALESCE(MAX(position), 0) as max_pos FROM cards WHERE column_id = $1",
        [columnId]
      );
      const newPosition = parseFloat(maxResult.rows[0].max_pos) + 1000;

      const id = uuidv4();
      const insertResult = await db.query(
        `INSERT INTO cards (id, column_id, text, position)
         VALUES ($1, $2, $3, $4)
         RETURNING id, column_id, text, position, created_at`,
        [id, columnId, text.trim(), newPosition]
      );

      return { card: insertResult.rows[0] };
    });

    if (result.error) {
      return res.status(result.status).json({ error: result.error });
    }

    broadcast("card:created", { card: result.card });
    res.status(201).json({ card: result.card });
  } catch (err) {
    console.error("POST /cards error:", err);
    res.status(500).json({ error: "Failed to create card" });
  }
});

// ─── PATCH /cards/:id/move ────────────────────────────────────────────────────

router.patch("/cards/:id/move", async (req, res) => {
  try {
    const result = await enqueueMutation(async () => {
      const db = await getDb();
      const { id } = req.params;
      const { columnId, afterId, beforeId } = req.body;

      if (!columnId) {
        return { error: "columnId is required", status: 400 };
      }

      // Verify the card exists
      const cardCheck = await db.query("SELECT id, column_id FROM cards WHERE id = $1", [id]);
      if (cardCheck.rows.length === 0) {
        return { error: "Card not found", status: 404 };
      }

      const oldColumnId = cardCheck.rows[0].column_id;

      // Verify target column exists
      const colCheck = await db.query("SELECT id FROM columns WHERE id = $1", [columnId]);
      if (colCheck.rows.length === 0) {
        return { error: "Column not found", status: 404 };
      }

      // Compute the new position
      let newPosition;

      if (afterId && beforeId) {
        // Between two cards
        const afterResult = await db.query(
          "SELECT position FROM cards WHERE id = $1",
          [afterId]
        );
        const beforeResult = await db.query(
          "SELECT position FROM cards WHERE id = $1",
          [beforeId]
        );

        if (afterResult.rows.length === 0 || beforeResult.rows.length === 0) {
          return { error: "Invalid afterId or beforeId", status: 400 };
        }

        const afterPos = parseFloat(afterResult.rows[0].position);
        const beforePos = parseFloat(beforeResult.rows[0].position);
        newPosition = (afterPos + beforePos) / 2;
      } else if (afterId) {
        // After a card (at the end)
        const afterResult = await db.query(
          "SELECT position FROM cards WHERE id = $1",
          [afterId]
        );
        if (afterResult.rows.length === 0) {
          return { error: "Invalid afterId", status: 400 };
        }
        newPosition = parseFloat(afterResult.rows[0].position) + 1000;
      } else if (beforeId) {
        // Before a card (at the start)
        const beforeResult = await db.query(
          "SELECT position FROM cards WHERE id = $1",
          [beforeId]
        );
        if (beforeResult.rows.length === 0) {
          return { error: "Invalid beforeId", status: 400 };
        }
        newPosition = parseFloat(beforeResult.rows[0].position) / 2;
      } else {
        // Dropped into empty column or at the end
        const maxResult = await db.query(
          "SELECT COALESCE(MAX(position), 0) as max_pos FROM cards WHERE column_id = $1 AND id != $2",
          [columnId, id]
        );
        newPosition = parseFloat(maxResult.rows[0].max_pos) + 1000;
      }

      // Atomically update the card's column and position
      await db.query(
        `UPDATE cards SET column_id = $1, position = $2 WHERE id = $3`,
        [columnId, newPosition, id]
      );

      // Check for position collisions/precision issues and renormalize if needed
      const renormalized = await maybeRenormalize(db, columnId);

      // Re-fetch the card after potential renormalization
      const finalResult = await db.query(
        "SELECT id, column_id, text, position, created_at FROM cards WHERE id = $1",
        [id]
      );

      return {
        card: finalResult.rows[0],
        oldColumnId,
        renormalized,
      };
    });

    if (result.error) {
      return res.status(result.status).json({ error: result.error });
    }

    // Broadcast the move with canonical state
    broadcast("card:moved", { card: result.card });

    res.json({ card: result.card });
  } catch (err) {
    console.error("PATCH /cards/:id/move error:", err);
    res.status(500).json({ error: "Failed to move card" });
  }
});

// ─── DELETE /cards/:id ────────────────────────────────────────────────────────

router.delete("/cards/:id", async (req, res) => {
  try {
    const result = await enqueueMutation(async () => {
      const db = await getDb();
      const { id } = req.params;

      const deleteResult = await db.query(
        "DELETE FROM cards WHERE id = $1 RETURNING id, column_id",
        [id]
      );

      if (deleteResult.rows.length === 0) {
        return { error: "Card not found", status: 404 };
      }

      return { id, columnId: deleteResult.rows[0].column_id };
    });

    if (result.error) {
      return res.status(result.status).json({ error: result.error });
    }

    broadcast("card:deleted", { id: result.id, columnId: result.columnId });
    res.json({ success: true });
  } catch (err) {
    console.error("DELETE /cards/:id error:", err);
    res.status(500).json({ error: "Failed to delete card" });
  }
});

// ─── Renormalization ──────────────────────────────────────────────────────────

async function maybeRenormalize(db, columnId) {
  const cardsResult = await db.query(
    "SELECT id, position FROM cards WHERE column_id = $1 ORDER BY position ASC",
    [columnId]
  );

  const cards = cardsResult.rows;
  if (cards.length < 2) return false;

  // Check for collision or precision exhaustion
  let needsRenorm = false;
  for (let i = 1; i < cards.length; i++) {
    const diff = Math.abs(
      parseFloat(cards[i].position) - parseFloat(cards[i - 1].position)
    );
    // If positions are too close (less than 0.001) or equal, renormalize
    if (diff < 0.001) {
      needsRenorm = true;
      break;
    }
  }

  if (!needsRenorm) return false;

  console.log(`Renormalizing column ${columnId} (${cards.length} cards)`);

  // Renormalize: space evenly at intervals of 1000
  for (let i = 0; i < cards.length; i++) {
    const newPos = (i + 1) * 1000;
    await db.query("UPDATE cards SET position = $1 WHERE id = $2", [
      newPos,
      cards[i].id,
    ]);
  }

  // Broadcast full column renormalization
  const updatedCards = await db.query(
    "SELECT id, column_id, text, position, created_at FROM cards WHERE column_id = $1 ORDER BY position ASC",
    [columnId]
  );

  broadcast("column:renormalized", {
    columnId,
    cards: updatedCards.rows,
  });

  return true;
}

export default router;
