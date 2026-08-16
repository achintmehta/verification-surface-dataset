import fs from 'fs';

let code = fs.readFileSync('server/index.js', 'utf8');

// 1. Add tables to initDb
code = code.replace(
  /await db\.query\('CREATE INDEX IF NOT EXISTS idx_cards_column_position ON cards\(column_id, position, id\)'\);/,
  `await db.query('CREATE INDEX IF NOT EXISTS idx_cards_column_position ON cards(column_id, position, id)');
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
  \`);`
);

// 2. Update getBoard to include labels
code = code.replace(
  /const cardsResult = await conn\.query\([\s\S]*?'SELECT id, column_id, text, position, created_at FROM cards ORDER BY column_id ASC, position ASC, created_at ASC, id ASC'[\s\S]*?\);/,
  `const cardsResult = await conn.query(
    'SELECT id, column_id, text, position, created_at FROM cards ORDER BY column_id ASC, position ASC, created_at ASC, id ASC'
  );
  const cardLabelsResult = await conn.query(
    'SELECT cl.card_id, l.id, l.name, l.color FROM card_labels cl JOIN labels l ON cl.label_id = l.id'
  );
  const labelsByCardId = new Map();
  for (const row of cardLabelsResult.rows) {
    if (!labelsByCardId.has(row.card_id)) labelsByCardId.set(row.card_id, []);
    labelsByCardId.get(row.card_id).push({ id: row.id, name: row.name, color: row.color });
  }`
);

code = code.replace(
  /const column = byId\.get\(card\.column_id\);\n\s*if \(column\) column\.cards\.push\(card\);/,
  `const column = byId.get(card.column_id);
    if (column) {
      card.labels = labelsByCardId.get(card.id) || [];
      column.cards.push(card);
    }`
);

// 3. Update getCard to include labels
code = code.replace(
  /async function getCard\(id, conn = db\) {[\s\S]*?return result\.rows\[0\] \|\| null;\n}/,
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

// 4. Add label endpoints
const labelEndpoints = `
app.get('/api/labels', async (_req, res, next) => {
  try {
    const result = await db.query('SELECT id, name, color FROM labels ORDER BY name ASC');
    res.json(result.rows);
  } catch (error) {
    next(error);
  }
});

app.post('/api/labels', async (req, res, next) => {
  try {
    const { name, color } = req.body || {};
    if (!name || typeof name !== 'string' || name.trim().length === 0) {
      return res.status(400).json({ error: 'name is required and must be non-empty' });
    }
    if (!color || typeof color !== 'string' || !/^#[0-9A-Fa-f]{6}$/.test(color)) {
      return res.status(400).json({ error: 'color is required and must be a valid hex value' });
    }
    const id = randomUUID();
    try {
      await db.query('INSERT INTO labels (id, name, color) VALUES ($1, $2, $3)', [id, name.trim(), color]);
    } catch (err) {
      if (err.message.includes('unique constraint')) {
        return res.status(409).json({ error: 'Label name must be unique' });
      }
      throw err;
    }
    const label = { id, name: name.trim(), color };
    broadcast('mutation', { type: 'createLabel', label });
    res.status(201).json(label);
  } catch (error) {
    next(error);
  }
});

app.put('/api/labels/:id', async (req, res, next) => {
  try {
    const { name, color } = req.body || {};
    if (!name || typeof name !== 'string' || name.trim().length === 0) {
      return res.status(400).json({ error: 'name is required and must be non-empty' });
    }
    if (!color || typeof color !== 'string' || !/^#[0-9A-Fa-f]{6}$/.test(color)) {
      return res.status(400).json({ error: 'color is required and must be a valid hex value' });
    }
    try {
      const result = await db.query('UPDATE labels SET name = $1, color = $2 WHERE id = $3 RETURNING id, name, color', [name.trim(), color, req.params.id]);
      if (result.rows.length === 0) return res.status(404).json({ error: 'Label not found' });
      const label = result.rows[0];
      
      // Broadcast the updated label and the full board to update cards
      const board = await getBoard();
      broadcast('mutation', { type: 'updateLabel', label, board });
      res.json(label);
    } catch (err) {
      if (err.message.includes('unique constraint')) {
        return res.status(409).json({ error: 'Label name must be unique' });
      }
      throw err;
    }
  } catch (error) {
    next(error);
  }
});

app.delete('/api/labels/:id', async (req, res, next) => {
  try {
    const result = await db.query('DELETE FROM labels WHERE id = $1 RETURNING id', [req.params.id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Label not found' });
    
    // Broadcast the deleted label and the full board to update cards
    const board = await getBoard();
    broadcast('mutation', { type: 'deleteLabel', labelId: req.params.id, board });
    res.status(204).end();
  } catch (error) {
    next(error);
  }
});

app.post('/api/cards/:id/labels', async (req, res, next) => {
  try {
    const { labelId } = req.body || {};
    if (!labelId) return res.status(400).json({ error: 'labelId is required' });
    
    const card = await getCard(req.params.id);
    if (!card) return res.status(404).json({ error: 'Card not found' });
    
    try {
      await db.query('INSERT INTO card_labels (card_id, label_id) VALUES ($1, $2)', [req.params.id, labelId]);
    } catch (err) {
      if (!err.message.includes('unique constraint')) throw err;
    }
    
    const updatedCard = await getCard(req.params.id);
    const board = await getBoard();
    broadcast('mutation', { type: 'assignLabel', card: updatedCard, board });
    res.status(201).json(updatedCard);
  } catch (error) {
    next(error);
  }
});

app.delete('/api/cards/:id/labels/:labelId', async (req, res, next) => {
  try {
    await db.query('DELETE FROM card_labels WHERE card_id = $1 AND label_id = $2', [req.params.id, req.params.labelId]);
    
    const updatedCard = await getCard(req.params.id);
    if (!updatedCard) return res.status(404).json({ error: 'Card not found' });
    
    const board = await getBoard();
    broadcast('mutation', { type: 'unassignLabel', card: updatedCard, board });
    res.status(204).end();
  } catch (error) {
    next(error);
  }
});
`;

code = code.replace(
  /app\.get\('\/api\/stream', async \(req, res\) => {/,
  labelEndpoints + "\napp.get('/api/stream', async (req, res) => {"
);

fs.writeFileSync('server/index.js', code);
