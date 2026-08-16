import { PGlite } from '@electric-sql/pglite';

let db = null;
let columnsCache = [];

const DATA_DIR = './.pglite-data';

export async function initDB() {
  db = new PGlite(DATA_DIR);

  await db.exec(`
    CREATE TABLE IF NOT EXISTS columns (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      position REAL NOT NULL
    );
  `);

  await db.exec(`
    CREATE TABLE IF NOT EXISTS cards (
      id TEXT PRIMARY KEY,
      column_id TEXT NOT NULL,
      text TEXT NOT NULL,
      position REAL NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (column_id) REFERENCES columns(id)
    );
  `);

  // Seed default columns if none exist
  const { rows } = await db.query('SELECT COUNT(*) as count FROM columns');
  if (parseInt(rows[0].count) === 0) {
    await db.exec(`
      INSERT INTO columns (id, title, position) VALUES
      ('col-todo', 'To Do', 1),
      ('col-progress', 'In Progress', 2),
      ('col-done', 'Done', 3);
    `);
    columnsCache = [
      { id: 'col-todo', title: 'To Do', position: 1 },
      { id: 'col-progress', title: 'In Progress', position: 2 },
      { id: 'col-done', title: 'Done', position: 3 }
    ];
  } else {
    const { rows: cols } = await db.query('SELECT * FROM columns ORDER BY position');
    columnsCache = cols;
  }

  console.log('Database initialized with PGLite');
}

export async function getBoard() {
  const { rows: columns } = await db.query(`
    SELECT * FROM columns ORDER BY position
  `);

  for (const col of columns) {
    const { rows: cards } = await db.query(`
      SELECT * FROM cards 
      WHERE column_id = $1 
      ORDER BY position
    `, [col.id]);
    col.cards = cards;
  }

  return { columns };
}

function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).substr(2);
}

function getPositionBetween(afterPos, beforePos) {
  if (afterPos == null && beforePos == null) return 1000;
  if (afterPos == null) return beforePos - 1000; // shouldn't happen
  if (beforePos == null) return afterPos + 1000;
  return (afterPos + beforePos) / 2;
}

async function renormalizeColumn(columnId) {
  const { rows: cards } = await db.query(
    'SELECT id FROM cards WHERE column_id = $1 ORDER BY position',
    [columnId]
  );

  const tx = await db.transaction();
  try {
    for (let i = 0; i < cards.length; i++) {
      await tx.query(
        'UPDATE cards SET position = $1 WHERE id = $2',
        [(i + 1) * 1000, cards[i].id]
      );
    }
    await tx.commit();
  } catch (e) {
    await tx.rollback();
    throw e;
  }

  // Broadcast renormalization
  if (global.broadcast) {
    global.broadcast({ type: 'column-renormalized', columnId });
  }
}

export async function createCard(columnId, text) {
  // Find max position in column
  const { rows: maxRows } = await db.query(
    'SELECT MAX(position) as max_pos FROM cards WHERE column_id = $1',
    [columnId]
  );
  const maxPos = maxRows[0].max_pos || 0;
  const position = maxPos + 1000;

  const id = generateId();

  await db.query(
    `INSERT INTO cards (id, column_id, text, position) VALUES ($1, $2, $3, $4)`,
    [id, columnId, text, position]
  );

  const { rows } = await db.query('SELECT * FROM cards WHERE id = $1', [id]);
  const card = rows[0];

  if (global.broadcast) {
    global.broadcast({ type: 'card-created', card, columnId });
  }

  return card;
}

export async function moveCard(cardId, newColumnId, beforeId, afterId) {
  // Use transaction for atomicity
  const tx = await db.transaction();

  try {
    // Get current card to know old column (for potential cleanup)
    const { rows: currentRows } = await tx.query('SELECT * FROM cards WHERE id = $1', [cardId]);
    if (currentRows.length === 0) throw new Error('Card not found');
    const currentCard = currentRows[0];

    // Get positions
    let afterPos = null, beforePos = null;

    if (afterId) {
      const { rows } = await tx.query('SELECT position FROM cards WHERE id = $1', [afterId]);
      if (rows.length) afterPos = rows[0].position;
    }
    if (beforeId) {
      const { rows } = await tx.query('SELECT position FROM cards WHERE id = $1', [beforeId]);
      if (rows.length) beforePos = rows[0].position;
    }

    let newPosition = getPositionBetween(afterPos, beforePos);

    // Check for collision / precision issues
    if (afterPos !== null && beforePos !== null && Math.abs(newPosition - afterPos) < 0.0001) {
      // Too close, renormalize
      await tx.rollback();
      await renormalizeColumn(newColumnId);
      // Recompute after renormalization
      return moveCard(cardId, newColumnId, beforeId, afterId); // retry
    }

    // Update card
    await tx.query(
      `UPDATE cards SET column_id = $1, position = $2 WHERE id = $3`,
      [newColumnId, newPosition, cardId]
    );

    await tx.commit();

    // Fetch updated card
    const { rows: updated } = await db.query('SELECT * FROM cards WHERE id = $1', [cardId]);
    const updatedCard = updated[0];

    if (global.broadcast) {
      global.broadcast({ type: 'card-moved', card: updatedCard, columnId: newColumnId });
    }

    return updatedCard;
  } catch (err) {
    try { await tx.rollback(); } catch (_) {}
    throw err;
  }
}