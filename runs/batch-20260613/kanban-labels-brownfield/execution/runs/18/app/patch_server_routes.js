import fs from 'fs';

let code = fs.readFileSync('server/index.js', 'utf8');

const newRoutes = `
// --- Labels API ---

function isValidHexColor(color) {
  return typeof color === 'string' && /^#[0-9a-fA-F]{6}$/.test(color);
}

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
    if (!isValidHexColor(color)) {
      return res.status(400).json({ error: 'color must be a valid hex color (e.g. #ff0000)' });
    }
    
    const id = randomUUID();
    try {
      await db.query('INSERT INTO labels (id, name, color) VALUES ($1, $2, $3)', [id, name.trim(), color]);
    } catch (err) {
      if (err.message && err.message.includes('unique constraint')) {
        return res.status(409).json({ error: 'Label name must be unique' });
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
    if (!isValidHexColor(color)) {
      return res.status(400).json({ error: 'color must be a valid hex color' });
    }
    
    try {
      const result = await db.query('UPDATE labels SET name = $1, color = $2 WHERE id = $3 RETURNING id, name, color', [name.trim(), color, req.params.id]);
      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Label not found' });
      }
      const label = result.rows[0];
      broadcast('mutation', { type: 'update_label', label });
      res.json(label);
    } catch (err) {
      if (err.message && err.message.includes('unique constraint')) {
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
    broadcast('mutation', { type: 'delete_label', labelId: req.params.id });
    res.status(204).end();
  } catch (error) {
    next(error);
  }
});

app.post('/api/cards/:id/labels', async (req, res, next) => {
  try {
    const { labelId } = req.body || {};
    if (!labelId) return res.status(400).json({ error: 'labelId is required' });
    
    const cardId = req.params.id;
    try {
      await db.query('INSERT INTO card_labels (card_id, label_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [cardId, labelId]);
    } catch (err) {
      if (err.message && err.message.includes('foreign key constraint')) {
        return res.status(400).json({ error: 'Invalid card or label' });
      }
      throw err;
    }
    
    const card = await getCard(cardId);
    broadcast('mutation', { type: 'assign_label', cardId, labelId, card });
    res.status(201).json({ success: true });
  } catch (error) {
    next(error);
  }
});

app.delete('/api/cards/:id/labels/:labelId', async (req, res, next) => {
  try {
    const cardId = req.params.id;
    const labelId = req.params.labelId;
    await db.query('DELETE FROM card_labels WHERE card_id = $1 AND label_id = $2', [cardId, labelId]);
    
    const card = await getCard(cardId);
    if (card) {
      broadcast('mutation', { type: 'unassign_label', cardId, labelId, card });
    }
    res.status(204).end();
  } catch (error) {
    next(error);
  }
});

app.get('/api/stream',`;

code = code.replace("app.get('/api/stream',", newRoutes);

fs.writeFileSync('server/index.js', code);
