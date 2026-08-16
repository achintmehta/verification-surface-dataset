import express from 'express';
import cors from 'cors';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = process.env.PGLITE_DATA_DIR || path.join(rootDir, 'data', 'pglite');
const POSITION_STEP = 1000;
const MIN_GAP = 0.000001;

const db = new PGlite(DATA_DIR);
const app = express();

app.use(cors());
app.use(express.json());

const sseClients = new Set();

function rows(result) {
  return result?.rows || [];
}

async function initDatabase() {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS columns (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      position DOUBLE PRECISION NOT NULL UNIQUE
    );

    CREATE TABLE IF NOT EXISTS cards (
      id TEXT PRIMARY KEY,
      column_id TEXT NOT NULL REFERENCES columns(id) ON DELETE CASCADE,
      text TEXT NOT NULL,
      position DOUBLE PRECISION NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE INDEX IF NOT EXISTS idx_cards_column_position ON cards(column_id, position, created_at, id);
  `);

  const columnCount = rows(await db.query('SELECT COUNT(*)::int AS count FROM columns'))[0]?.count ?? 0;
  if (Number(columnCount) === 0) {
    const defaults = [
      ['todo', 'To Do', 1000],
      ['in-progress', 'In Progress', 2000],
      ['done', 'Done', 3000]
    ];

    for (const [id, title, position] of defaults) {
      await db.query('INSERT INTO columns (id, title, position) VALUES ($1, $2, $3)', [id, title, position]);
    }
  }
}

async function getBoardState(client = db) {
  const columnRows = rows(
    await client.query('SELECT id, title, position FROM columns ORDER BY position ASC, id ASC')
  );
  const cardRows = rows(
    await client.query(
      `SELECT id, column_id AS "columnId", text, position, created_at AS "createdAt"
       FROM cards
       ORDER BY column_id ASC, position ASC, created_at ASC, id ASC`
    )
  );

  const columns = columnRows.map((column) => ({ ...column, cards: [] }));
  const byId = new Map(columns.map((column) => [column.id, column]));

  for (const card of cardRows) {
    const column = byId.get(card.columnId);
    if (column) column.cards.push(card);
  }

  return { columns };
}

async function getCard(id, client = db) {
  return rows(
    await client.query(
      `SELECT id, column_id AS "columnId", text, position, created_at AS "createdAt"
       FROM cards WHERE id = $1`,
      [id]
    )
  )[0];
}

function sendSse(res, event, data) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function safeSendSse(res, event, data) {
  try {
    sendSse(res, event, data);
  } catch {
    sseClients.delete(res);
  }
}

async function broadcastMutation(type, payload) {
  // The small mutation event is useful for clients that want incremental updates.
  // The full authoritative board event is the convergence mechanism and also
  // covers position renormalization after precision exhaustion/collisions.
  const board = await getBoardState();

  for (const res of sseClients) {
    safeSendSse(res, 'mutation', { type, ...payload });
    safeSendSse(res, 'board', board);
  }
}

function findInsertionIndex(cards, beforeId, afterId) {
  if (beforeId) {
    const index = cards.findIndex((card) => card.id === beforeId);
    if (index !== -1) return index;
  }

  if (afterId) {
    const index = cards.findIndex((card) => card.id === afterId);
    if (index !== -1) return index + 1;
  }

  return cards.length;
}

function computeFractionalPosition(cards, insertionIndex) {
  const previous = cards[insertionIndex - 1];
  const next = cards[insertionIndex];

  if (previous && next) {
    const gap = Number(next.position) - Number(previous.position);
    const candidate = Number(previous.position) + gap / 2;
    return gap > MIN_GAP && Number.isFinite(candidate)
      ? { position: candidate, needsRenormalize: false }
      : { position: null, needsRenormalize: true };
  }

  if (previous) {
    const candidate = Number(previous.position) + POSITION_STEP;
    return Number.isFinite(candidate)
      ? { position: candidate, needsRenormalize: false }
      : { position: null, needsRenormalize: true };
  }

  if (next) {
    const nextPosition = Number(next.position);
    const candidate = nextPosition / 2;
    return nextPosition > MIN_GAP && candidate > 0 && Number.isFinite(candidate)
      ? { position: candidate, needsRenormalize: false }
      : { position: null, needsRenormalize: true };
  }

  return { position: POSITION_STEP, needsRenormalize: false };
}

async function renormalizeColumnWithMovedCard(client, columnId, cardId, insertionIndex) {
  const targetCards = rows(
    await client.query(
      `SELECT id FROM cards
       WHERE column_id = $1 AND id <> $2
       ORDER BY position ASC, created_at ASC, id ASC`,
      [columnId, cardId]
    )
  );

  const orderedIds = targetCards.map((card) => card.id);
  const boundedIndex = Math.max(0, Math.min(insertionIndex, orderedIds.length));
  orderedIds.splice(boundedIndex, 0, cardId);

  for (let i = 0; i < orderedIds.length; i += 1) {
    await client.query('UPDATE cards SET column_id = $1, position = $2 WHERE id = $3', [
      columnId,
      (i + 1) * POSITION_STEP,
      orderedIds[i]
    ]);
  }

  return getCard(cardId, client);
}

app.get('/api/health', (_req, res) => {
  res.json({ ok: true });
});

app.get('/api/board', async (_req, res, next) => {
  try {
    res.json(await getBoardState());
  } catch (error) {
    next(error);
  }
});

app.get('/api/stream', async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  sseClients.add(res);
  safeSendSse(res, 'board', await getBoardState());

  const heartbeat = setInterval(() => {
    try {
      res.write(': heartbeat\n\n');
    } catch {
      clearInterval(heartbeat);
      sseClients.delete(res);
    }
  }, 25_000);

  req.on('close', () => {
    clearInterval(heartbeat);
    sseClients.delete(res);
  });
});

app.post('/api/cards', async (req, res, next) => {
  try {
    const text = String(req.body?.text || '').trim();
    const columnId = String(req.body?.columnId || '');

    if (!text) return res.status(400).json({ error: 'Card text is required.' });
    if (!columnId) return res.status(400).json({ error: 'columnId is required.' });

    const column = rows(await db.query('SELECT id FROM columns WHERE id = $1', [columnId]))[0];
    if (!column) return res.status(404).json({ error: 'Column not found.' });

    const id = randomUUID();
    const maxPosition = rows(
      await db.query('SELECT COALESCE(MAX(position), 0) AS max FROM cards WHERE column_id = $1', [columnId])
    )[0]?.max;
    const position = Number(maxPosition || 0) + POSITION_STEP;

    await db.query('INSERT INTO cards (id, column_id, text, position) VALUES ($1, $2, $3, $4)', [
      id,
      columnId,
      text,
      position
    ]);

    const card = await getCard(id);
    res.status(201).json({ card });
    await broadcastMutation('create', { card, columnId: card.columnId });
  } catch (error) {
    next(error);
  }
});

app.patch('/api/cards/:id/move', async (req, res, next) => {
  try {
    const cardId = req.params.id;
    const columnId = String(req.body?.columnId || '');
    const beforeId = req.body?.beforeId ? String(req.body.beforeId) : null;
    const afterId = req.body?.afterId ? String(req.body.afterId) : null;

    if (!columnId) return res.status(400).json({ error: 'columnId is required.' });

    const result = await db.transaction(async (tx) => {
      const card = await getCard(cardId, tx);
      if (!card) return { status: 404, body: { error: 'Card not found.' } };

      const column = rows(await tx.query('SELECT id FROM columns WHERE id = $1', [columnId]))[0];
      if (!column) return { status: 404, body: { error: 'Column not found.' } };

      // Exclude the moving card so that intra-column reorders are computed as if
      // the card had already been lifted out of its old slot.
      const targetCards = rows(
        await tx.query(
          `SELECT id, position
           FROM cards
           WHERE column_id = $1 AND id <> $2
           ORDER BY position ASC, created_at ASC, id ASC`,
          [columnId, cardId]
        )
      );

      const insertionIndex = findInsertionIndex(targetCards, beforeId, afterId);
      const { position, needsRenormalize } = computeFractionalPosition(targetCards, insertionIndex);

      let canonicalCard;
      let renormalized = false;
      if (needsRenormalize) {
        canonicalCard = await renormalizeColumnWithMovedCard(tx, columnId, cardId, insertionIndex);
        renormalized = true;
      } else {
        await tx.query('UPDATE cards SET column_id = $1, position = $2 WHERE id = $3', [
          columnId,
          position,
          cardId
        ]);

        const duplicateCount = Number(
          rows(
            await tx.query('SELECT COUNT(*)::int AS count FROM cards WHERE column_id = $1 AND position = $2', [
              columnId,
              position
            ])
          )[0]?.count || 0
        );

        if (duplicateCount > 1) {
          canonicalCard = await renormalizeColumnWithMovedCard(tx, columnId, cardId, insertionIndex);
          renormalized = true;
        } else {
          canonicalCard = await getCard(cardId, tx);
        }
      }

      return { status: 200, body: { card: canonicalCard, renormalized } };
    });

    res.status(result.status).json(result.body);

    if (result.status === 200) {
      await broadcastMutation('move', {
        card: result.body.card,
        columnId: result.body.card.columnId,
        renormalized: result.body.renormalized
      });
    }
  } catch (error) {
    next(error);
  }
});

app.use(express.static(path.join(rootDir, 'dist')));
app.get(/.*/, (_req, res) => {
  res.sendFile(path.join(rootDir, 'dist', 'index.html'));
});

app.use((error, _req, res, _next) => {
  console.error(error);
  res.status(500).json({ error: 'Internal server error.' });
});

await initDatabase();
app.listen(PORT, () => {
  console.log(`Kanban backend listening on http://localhost:${PORT}`);
  console.log(`PGLite data directory: ${DATA_DIR}`);
});
