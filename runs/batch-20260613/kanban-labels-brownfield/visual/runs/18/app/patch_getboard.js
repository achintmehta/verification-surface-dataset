import fs from 'fs';

let code = fs.readFileSync('server/index.js', 'utf8');

const getBoardReplacement = `
async function getBoard(conn = db) {
  const columnsResult = await conn.query('SELECT id, title, position FROM columns ORDER BY position ASC, id ASC');
  const cardsResult = await conn.query(
    'SELECT id, column_id, text, position, created_at FROM cards ORDER BY column_id ASC, position ASC, created_at ASC, id ASC'
  );
  const cardLabelsResult = await conn.query(
    'SELECT cl.card_id, l.id, l.name, l.color FROM card_labels cl JOIN labels l ON cl.label_id = l.id'
  );

  const labelsByCardId = new Map();
  for (const row of cardLabelsResult.rows) {
    if (!labelsByCardId.has(row.card_id)) labelsByCardId.set(row.card_id, []);
    labelsByCardId.get(row.card_id).push({ id: row.id, name: row.name, color: row.color });
  }

  const columns = columnsResult.rows.map((column) => ({ ...column, cards: [] }));
  const byId = new Map(columns.map((column) => [column.id, column]));
  for (const card of cardsResult.rows) {
    const column = byId.get(card.column_id);
    if (column) {
      card.labels = labelsByCardId.get(card.id) || [];
      column.cards.push(card);
    }
  }
  return { columns };
}

async function getCard(id, conn = db) {
  const result = await conn.query('SELECT id, column_id, text, position, created_at FROM cards WHERE id = $1', [id]);
  const card = result.rows[0] || null;
  if (card) {
    const labelsResult = await conn.query(
      'SELECT l.id, l.name, l.color FROM card_labels cl JOIN labels l ON cl.label_id = l.id WHERE cl.card_id = $1',
      [id]
    );
    card.labels = labelsResult.rows;
  }
  return card;
}
`;

code = code.replace(/async function getBoard[\s\S]*?async function columnExists/m, getBoardReplacement.trim() + '\n\nasync function columnExists');

fs.writeFileSync('server/index.js', code);
