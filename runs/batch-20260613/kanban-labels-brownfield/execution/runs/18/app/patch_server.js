import fs from 'fs';

let code = fs.readFileSync('server/index.js', 'utf8');

// 1. Update initDb
const initDbReplacement = `
  await db.query('CREATE INDEX IF NOT EXISTS idx_cards_column_position ON cards(column_id, position, id)');

  await db.query(\`
    CREATE TABLE IF NOT EXISTS labels (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE CHECK (name <> ''),
      color TEXT NOT NULL
    )
  \`);
  await db.query(\`
    CREATE TABLE IF NOT EXISTS card_labels (
      card_id TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
      label_id TEXT NOT NULL REFERENCES labels(id) ON DELETE CASCADE,
      PRIMARY KEY (card_id, label_id)
    )
  \`);

  const count = await db.query('SELECT COUNT(*)::int AS count FROM columns');
`;
code = code.replace(`  await db.query('CREATE INDEX IF NOT EXISTS idx_cards_column_position ON cards(column_id, position, id)');\n\n  const count = await db.query('SELECT COUNT(*)::int AS count FROM columns');`, initDbReplacement);

// 2. Update getBoard to include labels
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
    card.labels = labelsByCardId.get(card.id) || [];
    const column = byId.get(card.column_id);
    if (column) column.cards.push(card);
  }
  return { columns };
}
`;
code = code.replace(/async function getBoard\(conn = db\) \{[\s\S]*?return \{ columns \};\n\}/, getBoardReplacement);

// 3. Update getCard to include labels
const getCardReplacement = `
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
code = code.replace(/async function getCard\(id, conn = db\) \{[\s\S]*?return result\.rows\[0\] \|\| null;\n\}/, getCardReplacement);

fs.writeFileSync('server/index.js', code);
