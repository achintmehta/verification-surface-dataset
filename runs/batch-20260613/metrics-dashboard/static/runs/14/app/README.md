# Metrics Dashboard

A read-mostly analytics dashboard built as a traditional client-server web app.

- **Backend** — Node.js + Express + embedded [PGLite](https://pglite.dev). Seeds a
  deterministic metrics dataset on first boot and serves it as JSON.
- **Frontend** — Vanilla JS + Vite. Responsive CSS-Grid dashboard with a
  hand-drawn SVG time-series chart, category bars, a recent-items table, and a
  server-persisted light/dark theme toggle.

## Layout

```
package.json        # root: runs server + client together
server/             # Express API + PGLite
client/             # Vite frontend
```

## Setup

Dependencies are installed per package:

```bash
npm install            # root (concurrently)
npm --prefix server install
npm --prefix client install
# or, in one go:
npm run install:all
```

## Development

Run both dev servers together:

```bash
npm run dev
```

- API:    http://localhost:3001
- Client: http://localhost:5173 (proxies `/api` to the backend)

The PGLite database is written to `server/pgdata/` and seeded once. Delete that
directory to re-seed from scratch.

## API

| Method | Path              | Description                                          |
| ------ | ----------------- | ---------------------------------------------------- |
| GET    | `/api/summary`    | total visitors, total revenue, best day, 7-day trend |
| GET    | `/api/timeseries` | 30 days of `{ date, visitors, revenue }`             |
| GET    | `/api/categories` | 6 categories `{ name, value }`                       |
| GET    | `/api/recent`     | 20 recent items `{ name, category, value, createdAt }`|
| GET    | `/api/settings`   | `{ theme }`                                          |
| PUT    | `/api/settings`   | persist `{ theme: "light" \| "dark" }`               |

## Responsive behaviour

- `< 640px`: single column.
- `640–1023px`: two columns; stat cards 2-across.
- `≥ 1024px`: stat cards 4-across in one row; chart and breakdown side by side.

No horizontal page scroll at any width ≥ 360px. The chart redraws to fit its
container on resize via `ResizeObserver`.

## Production build

```bash
npm run build                 # builds client/dist
npm --prefix server start     # Express also serves client/dist
```
