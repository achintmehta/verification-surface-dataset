# Metrics Dashboard

A read-mostly analytics dashboard built as a client-server web app.

- **Backend** — Node.js + Express + embedded [PGLite](https://pglite.dev). Seeds a
  deterministic metrics dataset on first boot and serves it as JSON.
- **Frontend** — Vanilla JS + Vite. Responsive CSS-Grid dashboard with a
  hand-drawn SVG chart (no chart library) and a server-persisted theme toggle.

## Getting started

```bash
npm install
npm run dev
```

- `npm run dev` runs the API server (port **3001**) and the Vite dev server
  (port **5173**) together. Open <http://localhost:5173>.
- The Vite dev server proxies `/api/*` to the backend.

### Individual processes

```bash
npm run dev:server   # Express + PGLite on :3001
npm run dev:client   # Vite on :5173
```

### Production-style run

```bash
npm run build        # builds the frontend into dist/
npm start            # Express serves the API and the built frontend on :3001
```

## Data & persistence

PGLite writes to `./.pgdata`. The deterministic seed (`server/db.js`) creates:

- `daily_metrics` — 30 days of `visitors` / `revenue`
- `categories` — 6 rows, including a deliberately long label and a value ≥ 1,000,000
- `recent_items` — 20 rows
- `settings` — the persisted `theme`

The seed only runs when the database is empty, so theme changes (and the data)
survive a full server restart. Delete `.pgdata/` to reseed from scratch.

## API

| Method | Path              | Description                                            |
| ------ | ----------------- | ------------------------------------------------------ |
| GET    | `/api/summary`    | total visitors, total revenue, best day, 7-day trend % |
| GET    | `/api/timeseries` | 30-day series of visitors/revenue                      |
| GET    | `/api/categories` | category breakdown                                     |
| GET    | `/api/recent`     | 20 most recent items                                   |
| GET    | `/api/settings`   | `{ "theme": "light" \| "dark" }`                       |
| PUT    | `/api/settings`   | persist `{ "theme": "light" \| "dark" }`               |

## Responsive layout

- `< 640px` — single column.
- `640–1023px` — two columns (stat cards 2-up).
- `≥ 1024px` — four stat cards in one row; chart and breakdown side by side below.

The page never scrolls horizontally at any width ≥ 360px; the chart redraws to
fit its container on resize; long category labels truncate with an ellipsis.

If the backend is offline, the page shows an explicit error state instead of
stale content.
