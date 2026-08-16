const express = require('express');
const { getDb } = require('../db');

const router = express.Router();

// GET /api/board - Return all columns with their cards ordered by position
router.get('/board', async (req, res) => {
  try {
    const db = getDb();

    const columnsResult = await db.query(
      'SELECT id, title, position FROM columns ORDER BY position ASC'
    );

    const cardsResult = await db.query(
      'SELECT id, column_id, text, position, created_at FROM cards ORDER BY position ASC'
    );

    // Group cards by column
    const cardsByColumn = {};
    for (const card of cardsResult.rows) {
      if (!cardsByColumn[card.column_id]) {
        cardsByColumn[card.column_id] = [];
      }
      cardsByColumn[card.column_id].push({
        id: card.id,
        columnId: card.column_id,
        text: card.text,
        position: card.position,
        createdAt: card.created_at
      });
    }

    const columns = columnsResult.rows.map(col => ({
      id: col.id,
      title: col.title,
      position: col.position,
      cards: cardsByColumn[col.id] || []
    }));

    res.json({ columns });
  } catch (err) {
    console.error('Error fetching board:', err);
    res.status(500).json({ error: 'Failed to fetch board' });
  }
});

module.exports = router;
