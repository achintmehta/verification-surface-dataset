import express from "express";
import cors from "cors";
import { getDb } from "./db.js";
import { addClient, broadcast } from "./sse.js";
import {
  computePosition,
  needsRenormalization,
  renormalize,
  POSITION_GAP,
} from "./position.js";

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Serialize all mutations to avoid race conditions since PGLite is single-connection
let mutationQueue = Promise.resolve();

function serializeMutation(fn) {
  const p = mutationQueue.then(fn, fn);
  mutationQueue = p.catch(() => {});
  return p;
}

// ─── SSE endpoint ────────────────────────────────────────────────────────────
app.get("/api/stream", (req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.write(":\n\n"); // comment to flush headers
  addClient(res);
});

// ─── GET /api/board ──────────────────────────────────────────────────────────
app.get("/api/board", async (_req, res) => {
  try {
    const db = await getDb();
    const columnsResult = await db.query(
      "SELECT id, title, position FROM columns ORDER BY position"
    );
    const cardsResult = await db.query(
      "SELECT id, column_id, text, position, created_at FROM cards ORDER BY position"
    );

    const columns = columnsResult.rows.map((col) => ({
      ...col,
      cards: cardsResult.rows
        .filter((card) => card.column_id === col.id)
        .sort((a, b) => a.position - b.position),
    }));

    res.json({ columns });
  } catch (err) {
    console.error("GET /api/board error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ─── POST /api/cards ─────────────────────────────────────────────────────────
app.post("/api/cards", async (req, res) => {
  try {
    const result = await serializeMutation(async () => {
      const db = await getDb();
      const { columnId, text } = req.body;

      if (!columnId || !text || !text.trim()) {
        return { status: 400, body: { error: "columnId and text are required" } };
      }

      // Verify column exists
      const colCheck = await db.query("SELECT id FROM columns WHERE id = $1", [
        columnId,
      ]);
      if (colCheck.rows.length === 0) {
        return { status: 404, body: { error: "Column not found" } };
      }

      // Find max position in this column
      const maxResult = await db.query(
        "SELECT COALESCE(MAX(position), 0) as max_pos FROM cards WHERE column_id = $1",
        [columnId]
      );
      const newPosition = maxResult.rows[0].max_pos + POSITION_GAP;

      const insertResult = await db.query(
        "INSERT INTO cards (column_id, text, position) VALUES ($1, $2, $3) RETURNING id, column_id, text, position, created_at",
        [columnId, text.trim(), newPosition]
      );

      const card = insertResult.rows[0];
      broadcast("card_created", { card });

      return { status: 201, body: { card } };
    });

    res.status(result.status).json(result.body);
  } catch (err) {
    console.error("POST /api/cards error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ─── PATCH /api/cards/:id/move ───────────────────────────────────────────────
app.patch("/api/cards/:id/move", async (req, res) => {
  try {
    const result = await serializeMutation(async () => {
      const db = await getDb();
      const cardId = parseInt(req.params.id, 10);
      const { columnId, afterId, beforeId } = req.body;

      if (!columnId) {
        return { status: 400, body: { error: "columnId is required" } };
      }

      // Verify card exists
      const cardCheck = await db.query(
        "SELECT id, column_id, position FROM cards WHERE id = $1",
        [cardId]
      );
      if (cardCheck.rows.length === 0) {
        return { status: 404, body: { error: "Card not found" } };
      }

      const oldColumnId = cardCheck.rows[0].column_id;

      // Verify target column exists
      const colCheck = await db.query("SELECT id FROM columns WHERE id = $1", [
        columnId,
      ]);
      if (colCheck.rows.length === 0) {
        return { status: 404, body: { error: "Column not found" } };
      }

      // Determine position values for afterId and beforeId
      let afterPos = null;
      let beforePos = null;

      if (afterId != null) {
        const afterResult = await db.query(
          "SELECT position FROM cards WHERE id = $1",
          [afterId]
        );
        if (afterResult.rows.length > 0) {
          afterPos = afterResult.rows[0].position;
        }
      }

      if (beforeId != null) {
        const beforeResult = await db.query(
          "SELECT position FROM cards WHERE id = $1",
          [beforeId]
        );
        if (beforeResult.rows.length > 0) {
          beforePos = beforeResult.rows[0].position;
        }
      }

      // If neither afterId nor beforeId given, place at the end of the column
      if (afterId == null && beforeId == null) {
        const maxResult = await db.query(
          "SELECT COALESCE(MAX(position), 0) as max_pos FROM cards WHERE column_id = $1 AND id != $2",
          [columnId, cardId]
        );
        afterPos = maxResult.rows[0].max_pos > 0 ? maxResult.rows[0].max_pos : null;
      }

      const newPosition = computePosition(afterPos, beforePos);

      // Atomic update: column_id and position in one query
      await db.query(
        "UPDATE cards SET column_id = $1, position = $2 WHERE id = $3",
        [columnId, newPosition, cardId]
      );

      // Check if we need to renormalize the target column
      const columnCards = await db.query(
        "SELECT id, position FROM cards WHERE column_id = $1 ORDER BY position",
        [columnId]
      );
      const positions = columnCards.rows.map((c) => c.position);

      let renormalized = false;
      if (needsRenormalization(positions)) {
        renormalized = true;
        const newPositions = renormalize(columnCards.rows.length);
        for (let i = 0; i < columnCards.rows.length; i++) {
          await db.query("UPDATE cards SET position = $1 WHERE id = $2", [
            newPositions[i],
            columnCards.rows[i].id,
          ]);
        }
      }

      // Also check source column if it's different
      if (oldColumnId !== columnId) {
        const sourceCards = await db.query(
          "SELECT id, position FROM cards WHERE column_id = $1 ORDER BY position",
          [oldColumnId]
        );
        const sourcePositions = sourceCards.rows.map((c) => c.position);
        if (needsRenormalization(sourcePositions)) {
          const newSourcePositions = renormalize(sourceCards.rows.length);
          for (let i = 0; i < sourceCards.rows.length; i++) {
            await db.query("UPDATE cards SET position = $1 WHERE id = $2", [
              newSourcePositions[i],
              sourceCards.rows[i].id,
            ]);
          }
        }
      }

      // Fetch the final state of the card
      const finalCardResult = await db.query(
        "SELECT id, column_id, text, position, created_at FROM cards WHERE id = $1",
        [cardId]
      );
      const card = finalCardResult.rows[0];

      if (renormalized) {
        // Broadcast full column renormalization for the target column
        const updatedCards = await db.query(
          "SELECT id, column_id, text, position, created_at FROM cards WHERE column_id = $1 ORDER BY position",
          [columnId]
        );
        broadcast("column_renormalized", {
          columnId,
          cards: updatedCards.rows,
        });
        // If cross-column move, we also need clients to remove from old column
        if (oldColumnId !== columnId) {
          broadcast("card_moved", { card, oldColumnId });
        }
      } else {
        broadcast("card_moved", { card, oldColumnId });
      }

      return { status: 200, body: { card } };
    });

    res.status(result.status).json(result.body);
  } catch (err) {
    console.error("PATCH /api/cards/:id/move error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ─── DELETE /api/cards/:id ───────────────────────────────────────────────────
app.delete("/api/cards/:id", async (req, res) => {
  try {
    const result = await serializeMutation(async () => {
      const db = await getDb();
      const cardId = parseInt(req.params.id, 10);

      const deleteResult = await db.query(
        "DELETE FROM cards WHERE id = $1 RETURNING id, column_id",
        [cardId]
      );

      if (deleteResult.rows.length === 0) {
        return { status: 404, body: { error: "Card not found" } };
      }

      broadcast("card_deleted", {
        cardId: deleteResult.rows[0].id,
        columnId: deleteResult.rows[0].column_id,
      });

      return { status: 200, body: { success: true } };
    });

    res.status(result.status).json(result.body);
  } catch (err) {
    console.error("DELETE /api/cards/:id error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ─── Start server ────────────────────────────────────────────────────────────
async function start() {
  await getDb(); // ensure DB is initialized
  app.listen(PORT, () => {
    console.log(`Kanban server running on http://localhost:${PORT}`);
  });
}

start().catch((err) => {
  console.error("Failed to start server:", err);
  process.exit(1);
});
