# Metrics Dashboard

A read-mostly analytics dashboard. Node.js + Express + embedded PGLite backend
serving a deterministically-seeded metrics dataset as JSON; a Vanilla JS / Vite
frontend renders a fully responsive dashboard with hand-drawn SVG charts and a
server-persisted light/dark theme.

## Stack

- **Backend:** Express, `@electric-sql/pglite` (embedded Postgres written to
  `server/pgdata`), `cors`.
- **Frontend:** Vanilla JS + Vite. No charting library — the time-series chart is
  drawn with our own SVG code and redraws on container resize.

## Run (development)

```bash
npm install
npm run dev
```

- `dev:server` starts the API on `http://localhost:3001`.
- `dev:client` starts Vite on `http://localhost:5173` and proxies `/api` to the
  backend.

Open http://localhost:5173.

## Run (production-style, single origin)

```bash
npm install
npm run build      # outputs ./dist
npm start          # Express serves the API and the built ./dist at :3001
```

Open http://localhost:3001.

## API

| Method | Path              | Description                                                    |
|--------|-------------------|---------------------------------------------------------------|
| GET    | `/api/summary`    | total visitors, total revenue, best day, 7-day trend %        |
| GET    | `/api/timeseries` | 30 days of `{ day, visitors, revenue }`                       |
| GET    | `/api/categories` | 6 categories `{ name, value }`                                |
| GET    | `/api/recent`     | 20 recent items `{ name, category, value, createdAt }`        |
| GET    | `/api/settings`   | `{ theme: "light" \| "dark" }`                               |
| PUT    | `/api/settings`   | persist `{ theme }`                                            |

## Seed

The database is seeded deterministically (fixed PRNG seed) on first boot:
30 daily-metric rows, 6 categories (one deliberately long label and one value
≥ 1,000,000), and 20 recent items. The seed runs only when `daily_metrics` is
empty, so data and the theme preference survive a full server restart. Delete
`server/pgdata` to re-seed.

## Responsive layout

- `< 640px`: single column.
- `640–1023px`: two columns (stat cards 2×2; chart + breakdown side by side;
  table full width).
- `≥ 1024px`: four stat cards in one row; chart and breakdown side by side below;
  table full width.

No horizontal page overflow at any width ≥ 360px; the chart fits its container at
all widths and redraws on resize; long category labels truncate with an ellipsis.
With the backend stopped the page shows an explicit error/empty state.
