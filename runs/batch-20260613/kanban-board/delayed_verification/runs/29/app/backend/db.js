import { PGlite } from '@electric-sql/pglite';

let db = null;

export async function initDb() {
  if (db) return db;
  db = new PGlite('./kanban-data');
  await db.exec(`
    CREATE TABLE IF NOT EXISTS columns (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      position REAL NOT NULL
    );
    CREATE TABLE IF NOT EXISTS cards (
      id TEXT PRIMARY KEY,
      column_id TEXT NOT NULL REFERENCES columns(id),
      text TEXT NOT NULL,
      position REAL NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
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
  }
  return db;
}

export async function getBoardState() {
  const db = await initDb();
  const columnsRes = await db.query('SELECT * FROM columns ORDER BY position');
  const columns = columnsRes.rows;
  for (const col of columns) {
    const cardsRes = await db.query(
      'SELECT * FROM cards WHERE column_id = $1 ORDER BY position',
      [col.id]
    );
    col.cards = cardsRes.rows;
  }
  return columns;
}

export async function createCard(columnId, text) {
  const db = await initDb();
  const id = 'card-' + Date.now() + '-' + Math.random().toString(36).substr(2, 9);
  // Get max position in column
  const posRes = await db.query(
    'SELECT COALESCE(MAX(position), 0) as max_pos FROM cards WHERE column_id = $1',
    [columnId]
  );
  const position = (posRes.rows[0].max_pos || 0) + 1000;
  await db.query(
    'INSERT INTO cards (id, column_id, text, position) VALUES ($1, $2, $3, $4)',
    [id, columnId, text, position]
  );
  const cardRes = await db.query('SELECT * FROM cards WHERE id = $1', [id]);
  return cardRes.rows[0];
}

export async function moveCard(cardId, newColumnId, beforeId, afterId) {
  const db = await initDb();
  return await db.transaction(async (tx) => {
    // Get current card
    const cardRes = await tx.query('SELECT * FROM cards WHERE id = $1', [cardId]);
    if (cardRes.rows.length === 0) throw new Error('Card not found');
    const card = cardRes.rows[0];

    // Compute new position
    let newPosition;
    if (beforeId && afterId) {
      const beforeRes = await tx.query('SELECT position FROM cards WHERE id = $1', [beforeId]);
      const afterRes = await tx.query('SELECT position FROM cards WHERE id = $1', [afterId]);
      const beforePos = beforeRes.rows[0]?.position || 0;
      const afterPos = afterRes.rows[0]?.position || 0;
      newPosition = (beforePos + afterPos) / 2;
    } else if (beforeId) {
      const beforeRes = await tx.query('SELECT position FROM cards WHERE id = $1', [beforeId]);
      newPosition = beforeRes.rows[0].position - 1;
    } else if (afterId) {
      const afterRes = await tx.query('SELECT position FROM cards WHERE id = $1', [afterId]);
      newPosition = afterRes.rows[0].position + 1;
    } else {
      // End of column
      const maxRes = await tx.query(
        'SELECT COALESCE(MAX(position), 0) as max_pos FROM cards WHERE column_id = $1',
        [newColumnId]
      );
      newPosition = (maxRes.rows[0].max_pos || 0) + 1000;
    }

    // Check for collision or precision issues
    const existingRes = await tx.query(
      'SELECT id FROM cards WHERE column_id = $1 AND position = $2 AND id != $3',
      [newColumnId, newPosition, cardId]
    );
    if (existingRes.rows.length > 0 || Math.abs(newPosition % 1) < 1e-10) {
      // Renormalize the column
      await renormalizeColumn(tx, newColumnId);
      // Recompute position after renormalize
      if (beforeId && afterId) {
        const beforeRes = await tx.query('SELECT position FROM cards WHERE id = $1', [beforeId]);
        const afterRes = await tx.query('SELECT position FROM cards WHERE id = $1', [afterId]);
        const beforePos = beforeRes.rows[0]?.position || 0;
        const afterPos = afterRes.rows[0]?.position || 0;
        newPosition = (beforePos + afterPos) / 2;
      } else if (beforeId) {
        const beforeRes = await tx.query('SELECT position FROM cards WHERE id = $1', [beforeId]);
        newPosition = beforeRes.rows[0].position - 1;
      } else if (afterId) {
        const afterRes = await tx.query('SELECT position FROM cards WHERE id = $1', [afterId]);
        newPosition = afterRes.rows[0].position + 1;
      } else {
        const maxRes = await tx.query(
          'SELECT COALESCE(MAX(position), 0) as max_pos FROM cards WHERE column_id = $1',
          [newColumnId]
        );
        newPosition = (maxRes.rows[0].max_pos || 0) + 1000;
      }
    }

    // Update card
    await tx.query(
      'UPDATE cards SET column_id = $1, position = $2 WHERE id = $3',
      [newColumnId, newPosition, cardId]
    );

    const updatedRes = await tx.query('SELECT * FROM cards WHERE id = $1', [cardId]);
    return updatedRes.rows[0];
  });
}

async function renormalizeColumn(tx, columnId) {
  const cardsRes = await tx.query(
    'SELECT id FROM cards WHERE column_id = $1 ORDER BY position',
    [columnId]
  );
  const cards = cardsRes.rows;
  for (let i = 0; i < cards.length; i++) {
    const newPos = (i + 1) * 1000;
    await tx.query('UPDATE cards SET position = $1 WHERE id = $2', [newPos, cards[i].id]);
  }
}

export async function getCard(cardId) {
  const db = await initDb();
  const res = await db.query('SELECT * FROM cards WHERE id = $1', [cardId]);
  return res.rows[0];
}
