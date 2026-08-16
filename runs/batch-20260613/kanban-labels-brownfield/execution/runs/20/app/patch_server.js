import fs from 'fs';

let code = fs.readFileSync('server/index.js', 'utf8');

// 1. Update initDb
const initDbReplacement = `
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
`;

code = code.replace("await db.query('CREATE INDEX IF NOT EXISTS idx_cards_column_position ON cards(column_id, position, id)');", "await db.query('CREATE INDEX IF NOT EXISTS idx_cards_column_position ON cards(column_id, position, id)');\n" + initDbReplacement);

// 2. Update getBoard
const getBoardReplacement = `
  const cardsResult = await conn.query(
    'SELECT id, column_id, text, position, created_at FROM cards ORDER BY column_id ASC, position ASC, created_at ASC, id ASC'
  );
  const cardLabelsResult = await conn.query(
    'SELECT cl.card_id, l.id, l.name, l.color FROM card_labels cl JOIN labels l ON cl.label_id = l.id'
  );
  const labelsByCard = new Map();
  for (const row of cardLabelsResult.rows) {
    if (!labelsByCard.has(row.card_id)) labelsByCard.set(row.card_id, []);
    labelsByCard.get(row.card_id).push({ id: row.id, name: row.name, color: row.color });
  }
`;

code = code.replace("const cardsResult = await conn.query(\n    'SELECT id, column_id, text, position, created_at FROM cards ORDER BY column_id ASC, position ASC, created_at ASC, id ASC'\n  );", getBoardReplacement);

const getBoardCardLoopReplacement = `
  for (const card of cardsResult.rows) {
    card.labels = labelsByCard.get(card.id) || [];
    const column = byId.get(card.column_id);
    if (column) column.cards.push(card);
  }
`;

code = code.replace("for (const card of cardsResult.rows) {\n    const column = byId.get(card.column_id);\n    if (column) column.cards.push(card);\n  }", getBoardCardLoopReplacement);

// 3. Update getCard
const getCardReplacement = `
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
`;

code = code.replace("const result = await conn.query('SELECT id, column_id, text, position, created_at FROM cards WHERE id = $1', [id]);\n  return result.rows[0] || null;", getCardReplacement);

// 4. Add endpoints
const endpoints = `
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
        return res.status(409).json({ error: 'label name must be unique' });
      }
      throw err;
    }
    const label = { id, name: name.trim(), color };
    broadcast('mutation', { type: 'label_created', label });
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
      if (result.rows.length === 0) return res.status(404).json({ error: 'label not found' });
      const label = result.rows[0];
      broadcast('mutation', { type: 'label_updated', label });
      res.json(label);
    } catch (err) {
      if (err.message.includes('unique constraint')) {
        return res.status(409).json({ error: 'label name must be unique' });
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
    if (result.rows.length === 0) return res.status(404).json({ error: 'label not found' });
    broadcast('mutation', { type: 'label_deleted', labelId: req.params.id });
    res.json({ success: true });
  } catch (error) {
    next(error);
  }
});

app.post('/api/cards/:id/labels', async (req, res, next) => {
  try {
    const { labelId } = req.body || {};
    if (!labelId) return res.status(400).json({ error: 'labelId is required' });
    try {
      await db.query('INSERT INTO card_labels (card_id, label_id) VALUES ($1, $2)', [req.params.id, labelId]);
    } catch (err) {
      if (err.message.includes('unique constraint')) {
        // Ignore duplicate assignment
      } else {
        throw err;
      }
    }
    const card = await getCard(req.params.id);
    if (!card) return res.status(404).json({ error: 'card not found' });
    broadcast('mutation', { type: 'card_label_added', cardId: req.params.id, labelId, card });
    res.status(201).json({ success: true });
  } catch (error) {
    next(error);
  }
});

app.delete('/api/cards/:id/labels/:labelId', async (req, res, next) => {
  try {
    await db.query('DELETE FROM card_labels WHERE card_id = $1 AND label_id = $2', [req.params.id, req.params.labelId]);
    const card = await getCard(req.params.id);
    if (!card) return res.status(404).json({ error: 'card not found' });
    broadcast('mutation', { type: 'card_label_removed', cardId: req.params.id, labelId: req.params.labelId, card });
    res.json({ success: true });
  } catch (error) {
    next(error);
  }
});
`;

code = code.replace("app.get('/api/stream', async (req, res) => {", endpoints + "\napp.get('/api/stream', async (req, res) => {");

fs.writeFileSync('server/index.js', code);
