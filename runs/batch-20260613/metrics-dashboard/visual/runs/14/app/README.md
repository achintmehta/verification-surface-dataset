# Metrics Dashboard

A read-mostly analytics dashboard built as a traditional client-server web app.

- **Backend**: Node.js + Express + embedded [PGLite](https://github.com/electric-sql/pglite). Seeds a deterministic metrics dataset on first boot and serves it as JSON. Theme preference is persisted server-side in PGLite.
- **Frontend**: Vanilla JS + Vite single-page dashboard with a hand-drawn (no library) responsive SVG chart and a CSS-Grid layout.

## Layout / Features

- Four summary stat cards (total visitors, total revenue, best day, 7-day trend %).
- A 30-day time-series line chart drawn with our own SVG code — axes, gridlines, labeled ticks — that **redraws to fit its container** on resize (via `ResizeObserver`).
- A category breakdown of horizontal bars with value labels; long names truncate with an ellipsis.
- A recent-items table that stays usable on narrow screens (it scrolls inside its own card; the page never scrolls sideways).
- A light/dark theme toggle whose preference round-trips through `PUT /api/settings` and survives reload **and** a full server restart.

### Responsive breakpoints

- `< 640px`: 1 column.
- `640–1023px`: 2 columns.
- `>= 1024px`: the four stat cards sit in one row; chart and breakdown are side by side below.

## Getting started

```bash
# Install everything (root + server + client)
npm run install:all

# Run backend (:3001) and frontend dev server (:5173) together
npm run dev
```

The Vite dev server proxies `/api/*` to the backend on port 3001. Open http://localhost:5173.

### Production-style single server

```bash
npm run build      # builds client into client/dist
npm start          # backend serves the API and the built client on :3001
```

Then open http://localhost:3001.

## API

| Method | Path              | Description                                            |
| ------ | ----------------- | ------------------------------------------------------ |
| GET    | `/api/summary`    | total visitors, total revenue, best day, 7-day trend % |
| GET    | `/api/timeseries` | 30 days of `{ day, visitors, revenue }`                |
| GET    | `/api/categories` | 6 categories `{ id, name, value }`                     |
| GET    | `/api/recent`     | 20 recent items `{ id, name, category, value, createdAt }` |
| GET    | `/api/settings`   | `{ theme: "light" \| "dark" }`                         |
| PUT    | `/api/settings`   | persist `{ theme }`                                    |

The database file lives in `server/pgdata/`. Delete it to re-seed from scratch.
