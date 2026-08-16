import express from 'express';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { initDb, getDb } from './db.js';
import logsRouter from './routes/logs.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3001;

// __dirname = server/src → ../../client/dist = app/client/dist
const CLIENT_DIST = path.resolve(__dirname, '../../client/dist');

async function main() {
  console.log('[server] Starting log explorer backend...');
  const bootStart = Date.now();

  await initDb();

  const app = express();

  app.use(cors({ origin: '*', methods: ['GET'] }));
  app.use(express.json());

  // Health check
  app.get('/health', (_req, res) => res.json({ status: 'ok' }));

  // API routes
  app.use('/api', logsRouter);

  // Serve static assets (JS, CSS, etc.) — but NOT index.html (handled below)
  app.use(express.static(CLIENT_DIST, { index: false }));

  // Serve index.html with inline bootstrap data so the first render is instant
  app.get('*', async (_req, res) => {
    try {
      const htmlPath = path.join(CLIENT_DIST, 'index.html');
      let html = fs.readFileSync(htmlPath, 'utf8');

      // Fetch first 100 rows + stats to inline
      const db = await getDb();

      const [countRes, rowsRes, statsRes] = await Promise.all([
        db.query('SELECT COUNT(*) AS cnt FROM logs'),
        db.query(
          'SELECT id, ts, severity, service, message FROM logs ORDER BY ts DESC, id DESC LIMIT 100'
        ),
        db.query('SELECT severity, COUNT(*) AS cnt FROM logs GROUP BY severity'),
      ]);

      const total = parseInt(countRes.rows[0].cnt, 10);
      const rows  = rowsRes.rows;

      const bySeverity = { debug: 0, info: 0, warn: 0, error: 0 };
      for (const r of statsRes.rows) bySeverity[r.severity] = parseInt(r.cnt, 10);

      const bootstrapData = JSON.stringify({ total, rows, bySeverity });

      // Inject before </body>
      html = html.replace(
        '</body>',
        `<script>window.__BOOTSTRAP__ = ${bootstrapData};</script>\n</body>`
      );

      res.setHeader('Content-Type', 'text/html');
      res.send(html);
    } catch (err) {
      console.error('[index.html]', err);
      res.sendFile(path.join(CLIENT_DIST, 'index.html'));
    }
  });

  app.listen(PORT, () => {
    const bootMs = Date.now() - bootStart;
    console.log(`[server] Listening on http://localhost:${PORT} (boot: ${bootMs}ms)`);
  });
}

main().catch((err) => {
  console.error('[server] Fatal error:', err);
  process.exit(1);
});
