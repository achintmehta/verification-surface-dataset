import { Router } from "express";
import type { Request, Response } from "express";
import { getDb } from "./db.js";
import { addClient, removeClient, broadcast } from "./sse.js";
import { computePosition, maybeRenormalize } from "./ordering.js";
import crypto from "crypto";

const router = Router();

// ── GET /api/board ──────────────────────────────────────────────────────────
// Returns all columns with their cards ordered by position.
router.get("/api/board", async (_req: Request, res: Response) => {
  try {
    const db = await getDb();
    const colResult = await db.query(
      "SELECT id, title, position FROM columns ORDER BY position ASC"
    );
    const columns = colResult.rows as Array<{
      id: string;
      title: string;
      position: number;
    }>;

    const cardResult = await db.query(
      `SELECT id, column_id, text, position, created_at::text as created_at
       FROM cards ORDER BY position ASC`
    );
    const allCards = cardResult.rows as Array<{
      id: string;
      column_id: string;
      text: string;
      position: number;
      created_at: string;
    }>;

    const board = columns.map((col) => ({
      ...col,
      cards: allCards.filter((c) => c.column_id === col.id),
    }));

    res.json(board);
  } catch (err) {
    console.error("GET /api/board error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ── POST /api/cards ─────────────────────────────────────────────────────────
// Create a new card at the end of a column.
// Body: { columnId: string, text: string }
router.post("/api/cards", async (req: Request, res: Response) => {
  try {
    const { columnId, text } = req.body as {
      columnId?: string;
      text?: string;
    };

    if (!columnId || !text || typeof text !== "string" || text.trim() === "") {
      res.status(400).json({ error: "columnId and text are required" });
      return;
    }

    const db = await getDb();

    // Verify column exists
    const colCheck = await db.query("SELECT id FROM columns WHERE id = $1", [
      columnId,
    ]);
    if ((colCheck.rows as Array<{ id: string }>).length === 0) {
      res.status(404).json({ error: "Column not found" });
      return;
    }

    // Get the maximum position in this column
    const maxResult = await db.query(
      "SELECT COALESCE(MAX(position), 0) AS max_pos FROM cards WHERE column_id = $1",
      [columnId]
    );
    const maxPos = (maxResult.rows[0] as { max_pos: number }).max_pos;

    const id = `card-${crypto.randomUUID()}`;
    const position = maxPos + 1000;

    await db.query(
      `INSERT INTO cards (id, column_id, text, position)
       VALUES ($1, $2, $3, $4)`,
      [id, columnId, text.trim(), position]
    );

    const inserted = await db.query(
      `SELECT id, column_id, text, position, created_at::text as created_at
       FROM cards WHERE id = $1`,
      [id]
    );
    const card = (
      inserted.rows as Array<{
        id: string;
        column_id: string;
        text: string;
        position: number;
        created_at: string;
      }>
    )[0];

    broadcast("card_created", card);
    res.status(201).json(card);
  } catch (err) {
    console.error("POST /api/cards error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ── PATCH /api/cards/:id/move ───────────────────────────────────────────────
// Move a card within or across columns.
// Body: { columnId: string, afterId: string | null, beforeId: string | null }
// afterId = the card that should appear BEFORE this card (above it)
// beforeId = the card that should appear AFTER this card (below it)
router.patch("/api/cards/:id/move", async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { columnId, afterId, beforeId } = req.body as {
      columnId?: string;
      afterId?: string | null;
      beforeId?: string | null;
    };

    if (!columnId) {
      res.status(400).json({ error: "columnId is required" });
      return;
    }

    const db = await getDb();

    // Use a transaction for atomicity
    await db.exec("BEGIN");

    try {
      // Verify card exists
      const cardCheck = await db.query("SELECT id FROM cards WHERE id = $1", [
        id,
      ]);
      if ((cardCheck.rows as Array<{ id: string }>).length === 0) {
        await db.exec("ROLLBACK");
        res.status(404).json({ error: "Card not found" });
        return;
      }

      // Verify target column exists
      const colCheck = await db.query("SELECT id FROM columns WHERE id = $1", [
        columnId,
      ]);
      if ((colCheck.rows as Array<{ id: string }>).length === 0) {
        await db.exec("ROLLBACK");
        res.status(404).json({ error: "Column not found" });
        return;
      }

      // Get positions of reference cards
      let afterPos: number | null = null;
      let beforePos: number | null = null;

      if (afterId) {
        const afterResult = await db.query(
          "SELECT position FROM cards WHERE id = $1",
          [afterId]
        );
        const afterRows = afterResult.rows as Array<{ position: number }>;
        if (afterRows.length > 0) {
          afterPos = afterRows[0].position;
        }
      }

      if (beforeId) {
        const beforeResult = await db.query(
          "SELECT position FROM cards WHERE id = $1",
          [beforeId]
        );
        const beforeRows = beforeResult.rows as Array<{ position: number }>;
        if (beforeRows.length > 0) {
          beforePos = beforeRows[0].position;
        }
      }

      // If neither reference was given, place at the end of the column
      if (afterPos == null && beforePos == null) {
        const maxResult = await db.query(
          "SELECT COALESCE(MAX(position), 0) AS max_pos FROM cards WHERE column_id = $1 AND id != $2",
          [columnId, id]
        );
        const maxPos = (maxResult.rows[0] as { max_pos: number }).max_pos;
        afterPos = maxPos > 0 ? maxPos : null;
      }

      const newPosition = computePosition(afterPos, beforePos);

      // Atomically update column_id and position
      await db.query(
        "UPDATE cards SET column_id = $1, position = $2 WHERE id = $3",
        [columnId, newPosition, id]
      );

      // Check if renormalization is needed
      const renormalized = await maybeRenormalize(db, columnId);

      await db.exec("COMMIT");

      // Fetch the final card state
      const finalResult = await db.query(
        `SELECT id, column_id, text, position, created_at::text as created_at
         FROM cards WHERE id = $1`,
        [id]
      );
      const card = (
        finalResult.rows as Array<{
          id: string;
          column_id: string;
          text: string;
          position: number;
          created_at: string;
        }>
      )[0];

      // If renormalization occurred, broadcast the full column state
      if (renormalized) {
        broadcast("column_renormalized", {
          columnId,
          cards: renormalized,
        });
      } else {
        broadcast("card_moved", card);
      }

      res.json(card);
    } catch (innerErr) {
      await db.exec("ROLLBACK");
      throw innerErr;
    }
  } catch (err) {
    console.error("PATCH /api/cards/:id/move error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ── GET /api/stream ─────────────────────────────────────────────────────────
// SSE endpoint for real-time updates.
router.get("/api/stream", (req: Request, res: Response) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  // Send initial connection confirmation
  res.write(
    `event: connected\ndata: ${JSON.stringify({ message: "Connected to SSE stream" })}\n\n`
  );

  const clientId = addClient(res);

  // Keep-alive heartbeat every 30 seconds
  const heartbeat = setInterval(() => {
    try {
      res.write(": heartbeat\n\n");
    } catch {
      clearInterval(heartbeat);
    }
  }, 30000);

  req.on("close", () => {
    clearInterval(heartbeat);
    removeClient(clientId);
  });
});

export default router;
