# Metrics Dashboard

A read-mostly analytics dashboard. A Node.js + Express server seeds and serves
a small metrics dataset from an embedded PGLite database; a Vanilla JS / Vite
single-page client renders it as a responsive dashboard with stat cards, a
hand-drawn time-series chart, a category breakdown, and a recent-items table.

## Stack

- **Backend:** Node.js, Express, `@electric-sql/pglite` (embedded Postgres), CORS
- **Frontend:** Vanilla JS + Vite. The chart is drawn by our own SVG code — no
  charting library.

## Getting started

```bash
# install root, server and client dependencies
npm run install:all

# run the API (:3001) and the Vite dev server (:5173) together
npm run dev
```

Then open http://localhost:5173. The Vite dev server proxies `/api/*` to the
backend on port 3001.

## API

| Method | Path             | Description                                          |
| ------ | ---------------- | ---------------------------------------------------- |
| GET    | `/api/summary`   | total visitors, total revenue, best day, 7-day trend |
| GET    | `/api/timeseries`| 30 days of `{ date, visitors, revenue }`             |
| GET    | `/api/categories`| 6 categories `{ name, value }`                       |
| GET    | `/api/recent`    | 20 recent items `{ name, category, value, createdAt }`|
| GET    | `/api/settings`  | `{ theme: "light" \| "dark" }`                       |
| PUT    | `/api/settings`  | persist `{ theme }`                                  |

## Data & seeding

On first boot the server creates the schema and seeds it deterministically
(fixed PRNG seed) into `server/pgdata/`:

- `daily_metrics` — 30 rows
- `categories` — 6 rows, including the long label
  "Enterprise Infrastructure & Compliance" and a 7-digit value (≥ 1,000,000)
- `recent_items` — 20 rows
- `settings` — theme preference (defaults to `light`)

Delete `server/pgdata/` to reseed from scratch.

## Responsive behavior

- **< 640px:** single column.
- **640–1023px:** two columns.
- **≥ 1024px:** four stat cards across the top row; chart and category
  breakdown side by side; the recent-items table spans the full width.

The chart re-reads its container size and redraws on resize. The page never
scrolls sideways at any width ≥ 360px.
