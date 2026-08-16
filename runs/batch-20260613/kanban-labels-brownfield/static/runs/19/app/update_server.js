import fs from 'fs';

const content = fs.readFileSync('server/index.js', 'utf8');

let newContent = content.replace(
  "await db.query('CREATE INDEX IF NOT EXISTS idx_cards_column_position ON cards(column_id, position, id)');",
  `await db.query('CREATE INDEX IF NOT EXISTS idx_cards_column_position ON cards(column_id, position, id)');

  await db.query(\`
    CREATE TABLE IF NOT EXISTS labels (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
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

newContent = newContent.replace(
  "const cardsResult = await conn.query(\n    'SELECT id, column_id, text, position, created_at FROM cards ORDER BY column_id ASC, position ASC, created_at ASC, id ASC'\n  );",
  `const cardsResult = await conn.query(
    'SELECT id, column_id, text, position, created_at FROM cards ORDER BY column_id ASC, position ASC, created_at ASC, id ASC'
  );
  const cardLabelsResult = await conn.query(\`
    SELECT cl.card_id, l.id, l.name, l.color
    FROM card_labels cl
    JOIN labels l ON cl.label_id = l.id
  \`);

  const labelsByCardId = new Map();
  for (const row of cardLabelsResult.rows) {
    if (!labelsByCardId.has(row.card_id)) {
      labelsByCardId.set(row.card_id, []);
    }
    labelsByCardId.get(row.card_id).push({ id: row.id, name: row.name, color: row.color });
  }`
);

newContent = newContent.replace(
  "if (column) column.cards.push(card);",
  `if (column) {
      card.labels = labelsByCardId.get(card.id) || [];
      column.cards.push(card);
    }`
);

newContent = newContent.replace(
  "const result = await conn.query('SELECT id, column_id, text, position, created_at FROM cards WHERE id = $1', [id]);\n  return result.rows[0] || null;",
  `const result = await conn.query('SELECT id, column_id, text, position, created_at FROM cards WHERE id = $1', [id]);
  const card = result.rows[0] || null;
  if (card) {
    const labelsResult = await conn.query(\`
      SELECT l.id, l.name, l.color
      FROM card_labels cl
      JOIN labels l ON cl.label_id = l.id
      WHERE cl.card_id = $1
    \`, [id]);
    card.labels = labelsResult.rows;
  }
  return card;`
);

const newEndpoints = `
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
    if (!color || typeof color !== 'string' || !/^#[0-9A-Fa-f]{6}$/i.test(color)) {
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
    broadcast('mutation', { type: 'create_label', label });
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
    if (!color || typeof color !== 'string' || !/^#[0-9A-Fa-f]{6}$/i.test(color)) {
      return res.status(400).json({ error: 'color is required and must be a valid hex value' });
    }
    try {
      const result = await db.query('UPDATE labels SET name = $1, color = $2 WHERE id = $3 RETURNING id, name, color', [name.trim(), color, req.params.id]);
      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'label not found' });
      }
      const label = result.rows[0];
      broadcast('mutation', { type: 'update_label', label });
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
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'label not found' });
    }
    broadcast('mutation', { type: 'delete_label', labelId: req.params.id });
    res.status(204).end();
  } catch (error) {
    next(error);
  }
});

app.post('/api/cards/:id/labels', async (req, res, next) => {
  try {
    const { labelId } = req.body || {};
    if (!labelId) {
      return res.status(400).json({ error: 'labelId is required' });
    }
    try {
      await db.query('INSERT INTO card_labels (card_id, label_id) VALUES ($1, $2)', [req.params.id, labelId]);
    } catch (err) {
      if (err.message.includes('unique constraint')) {
        // already assigned, ignore
      } else if (err.message.includes('foreign key constraint')) {
        return res.status(404).json({ error: 'card or label not found' });
      } else {
        throw err;
      }
    }
    const card = await getCard(req.params.id);
    broadcast('mutation', { type: 'assign_label', cardId: req.params.id, labelId, card });
    res.status(201).json({ success: true });
  } catch (error) {
    next(error);
  }
});

app.delete('/api/cards/:id/labels/:labelId', async (req, res, next) => {
  try {
    await db.query('DELETE FROM card_labels WHERE card_id = $1 AND label_id = $2', [req.params.id, req.params.labelId]);
    const card = await getCard(req.params.id);
    broadcast('mutation', { type: 'unassign_label', cardId: req.params.id, labelId: req.params.labelId, card });
    res.status(204).end();
  } catch (error) {
    next(error);
  }
});

app.get('/api/stream',`;

newContent = newContent.replace("app.get('/api/stream',", newEndpoints);

fs.writeFileSync('server/index.js', newContent);
