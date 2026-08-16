const fs = require('fs');
let code = fs.readFileSync('server/index.js', 'utf8');

code = code.replace(
  /async function getCard\(id, conn = db\) \{[\s\S]*?return result\.rows\[0\] \|\| null;\n\}/,
  `async function getCard(id, conn = db) {
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
}`
);

fs.writeFileSync('server/index.js', code);
