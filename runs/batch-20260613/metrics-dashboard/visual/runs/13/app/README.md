# Metrics Dashboard

A read-mostly analytics dashboard. Node.js + Express + embedded PGLite backend
serving a deterministically-seeded metrics dataset as JSON; a Vanilla JS + Vite
frontend rendering a fully responsive dashboard with a hand-drawn SVG chart and a
server-persisted light/dark theme.

## Stack

- **Backend**: `express`, `@electric-sql/pglite`, `cors` (`server/`)
- **Frontend**: Vanilla JS + Vite (`client/`)

## Running

```bash
npm install
npm run dev      # runs the API server (:3001) and Vite dev server (:5173) together
```

Open http://localhost:5173. Vite proxies `/api/*` to the backend on :3001.

For a production-style single-origin run:

```bash
npm run build    # outputs to dist/
npm start        # Express serves the API and the built frontend on :3001
```

## API

| Method | Path              | Description                                            |
| ------ | ----------------- | ------------------------------------------------------ |
| GET    | `/api/summary`    | total visitors, total revenue, best day, 7-day trend % |
| GET    | `/api/timeseries` | 30 days of `{ date, visitors, revenue }`               |
| GET    | `/api/categories` | 6 categories `{ name, value }`                         |
| GET    | `/api/recent`     | 20 recent items `{ name, category, value, createdAt }` |
| GET    | `/api/settings`   | `{ theme: "light" \| "dark" }`                         |
| PUT    | `/api/settings`   | persist `{ theme }`                                    |

## Data

The database (PGLite, stored under `server/pgdata/`) is seeded deterministically
on first boot using a fixed PRNG seed: 30 days of `daily_metrics`, 6 `categories`
(including the long label *"Enterprise Infrastructure & Compliance"* and a value
≥ 1,000,000), 20 `recent_items`, and a `settings` row.

## Responsive layout

- `< 640px`: single column.
- `640–1023px`: two columns; stat cards 2-across, chart + breakdown side by side,
  table full-width.
- `≥ 1024px`: four stat cards in one row; chart and breakdown side by side below;
  table full-width.

The SVG chart redraws to fit its container on resize (via `ResizeObserver`), and
the theme toggle round-trips through `PUT /api/settings`, surviving reloads and
full server restarts. With the backend offline, the page shows an explicit error
state instead of stale content.
