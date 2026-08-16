const express = require("express");
const { getDb } = require("../db");

const router = express.Router();

/**
 * GET /api/board
 * Returns all columns with their cards ordered by position.
 */
router.get("/board", async (_req, res, next) => {
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
    next(err);
  }
});

module.exports = router;
