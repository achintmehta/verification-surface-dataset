import fs from 'fs';

let code = fs.readFileSync('server/index.js', 'utf8');

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
      return res.status(400).json({ error: 'non-empty name is required' });
    }
    if (!color || typeof color !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(color)) {
      return res.status(400).json({ error: 'valid hex color is required' });
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
      return res.status(400).json({ error: 'non-empty name is required' });
    }
    if (!color || typeof color !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(color)) {
      return res.status(400).json({ error: 'valid hex color is required' });
    }
    try {
      const result = await db.query('UPDATE labels SET name = $1, color = $2 WHERE id = $3 RETURNING id, name, color', [name.trim(), color, req.params.id]);
      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'label not found' });
      }
      const label = result.rows[0];
      const board = await getBoard();
      broadcast('mutation', { type: 'update_label', label, board });
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
    const board = await getBoard();
    broadcast('mutation', { type: 'delete_label', labelId: req.params.id, board });
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
    if (!card) return res.status(404).json({ error: 'card not found' });

    try {
      await db.query('INSERT INTO card_labels (card_id, label_id) VALUES ($1, $2)', [req.params.id, labelId]);
    } catch (err) {
      if (!err.message.includes('unique constraint')) {
        throw err;
      }
    }
    
    const updatedCard = await getCard(req.params.id);
    const board = await getBoard();
    broadcast('mutation', { type: 'assign_label', card: updatedCard, board });
    res.status(201).json(updatedCard);
  } catch (error) {
    next(error);
  }
});

app.delete('/api/cards/:id/labels/:labelId', async (req, res, next) => {
  try {
    const result = await db.query('DELETE FROM card_labels WHERE card_id = $1 AND label_id = $2', [req.params.id, req.params.labelId]);
    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'assignment not found' });
    }
    
    const updatedCard = await getCard(req.params.id);
    const board = await getBoard();
    broadcast('mutation', { type: 'unassign_label', card: updatedCard, board });
    res.status(204).end();
  } catch (error) {
    next(error);
  }
});

app.get('/api/stream', async (req, res) => {
`;

code = code.replace(/app\.get\('\/api\/stream', async \(req, res\) => \{/, endpoints);

fs.writeFileSync('server/index.js', code);
