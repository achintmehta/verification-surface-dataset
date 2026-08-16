# Metrics Dashboard

A read-mostly analytics dashboard. Express + embedded PGLite backend serving a
deterministically-seeded metrics dataset as JSON; a Vite / Vanilla-JS frontend
that renders a fully responsive dashboard with a hand-drawn SVG chart.

## Stack

- **Backend:** Node.js, Express, `@electric-sql/pglite` (embedded Postgres), CORS.
- **Frontend:** Vite + Vanilla JS, CSS Grid layout, hand-drawn SVG chart (no chart library).

## Running

Install dependencies, then run the backend and frontend dev servers together:

```bash
npm install
npm run dev
```

- Frontend dev server: http://localhost:5173 (proxies `/api/*` to the backend)
- Backend API server:   http://localhost:3001

Run them individually with `npm run dev:server` and `npm run dev:client`.

### Production build

```bash
npm run build   # builds the frontend into ./dist
npm start       # backend serves the API and the built frontend on :3001
```

## Data & persistence

PGLite stores its data under `./pgdata`. On first boot the database is seeded
deterministically (fixed PRNG seed):

- `daily_metrics` — 30 days of `date, visitors, revenue`
- `categories` — 6 rows incl. a deliberately long label and a value ≥ 1,000,000
- `recent_items` — 20 rows
- `settings` — persisted theme (`light` | `dark`)

The seed runs only when `daily_metrics` is empty, so values are stable across
restarts. The theme preference round-trips through `GET/PUT /api/settings` and
survives both reload and a full server restart.

## API

| Method | Path              | Description                                            |
|--------|-------------------|--------------------------------------------------------|
| GET    | `/api/summary`    | total visitors, total revenue, best day, 7-day trend % |
| GET    | `/api/timeseries` | 30-day series of `{ date, visitors, revenue }`         |
| GET    | `/api/categories` | category breakdown `{ name, value }`                   |
| GET    | `/api/recent`     | 20 recent items                                        |
| GET    | `/api/settings`   | `{ theme }`                                            |
| PUT    | `/api/settings`   | persist `{ theme: "light" | "dark" }`                  |

## Responsive layout

- `< 640px` — single column.
- `640–1023px` — two columns.
- `≥ 1024px` — four stat cards in one row; chart and category breakdown side by
  side below; table spans full width.

No horizontal page scroll at any width ≥ 360px. The SVG chart redraws to fit its
container on resize (via `ResizeObserver`) and restyles its axes, gridlines and
series with the active theme. With the backend stopped the page shows an explicit
error state with a retry button instead of stale content.
