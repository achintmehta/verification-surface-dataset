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
    const result = await db.query('SELECT id, name, color FROM labels WHERE id = $1', [id]);
    const label = result.rows[0];
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
    if (!color || typeof color !== 'string' || !/^#[0-9A-Fa-f]{6}$/.test(color)) {
      return res.status(400).json({ error: 'color is required and must be a valid hex value' });
    }
    try {
      const result = await db.query('UPDATE labels SET name = $1, color = $2 WHERE id = $3 RETURNING id, name, color', [name.trim(), color, req.params.id]);
      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Label not found' });
      }
      const label = result.rows[0];
      const board = await getBoard();
      broadcast('mutation', { type: 'update_label', label, board });
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
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Label not found' });
    }
    const board = await getBoard();
    broadcast('mutation', { type: 'delete_label', labelId: req.params.id, board });
    res.json({ success: true });
  } catch (error) {
    next(error);
  }
});

app.post('/api/cards/:id/labels', async (req, res, next) => {
  try {
    const { labelId } = req.body || {};
    if (!labelId) return res.status(400).json({ error: 'labelId is required' });
    
    const cardResult = await db.query('SELECT id FROM cards WHERE id = $1', [req.params.id]);
    if (cardResult.rows.length === 0) return res.status(404).json({ error: 'Card not found' });
    
    const labelResult = await db.query('SELECT id FROM labels WHERE id = $1', [labelId]);
    if (labelResult.rows.length === 0) return res.status(404).json({ error: 'Label not found' });

    try {
      await db.query('INSERT INTO card_labels (card_id, label_id) VALUES ($1, $2)', [req.params.id, labelId]);
    } catch (err) {
      if (!err.message.includes('unique constraint')) throw err;
    }
    
    const board = await getBoard();
    broadcast('mutation', { type: 'assign_label', cardId: req.params.id, labelId, board });
    res.status(201).json({ success: true });
  } catch (error) {
    next(error);
  }
});

app.delete('/api/cards/:id/labels/:labelId', async (req, res, next) => {
  try {
    await db.query('DELETE FROM card_labels WHERE card_id = $1 AND label_id = $2', [req.params.id, req.params.labelId]);
    const board = await getBoard();
    broadcast('mutation', { type: 'unassign_label', cardId: req.params.id, labelId: req.params.labelId, board });
    res.json({ success: true });
  } catch (error) {
    next(error);
  }
});
`;

code = code.replace(/app\.get\('\/api\/stream',/, endpoints + "\napp.get('/api/stream',");
fs.writeFileSync('server/index.js', code);
