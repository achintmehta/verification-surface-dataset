# Metrics Dashboard

A read-mostly analytics dashboard. Node.js + Express + embedded PGLite backend
serving a deterministically-seeded metrics dataset as JSON; a Vite + Vanilla JS
frontend rendering a fully responsive dashboard with a hand-drawn SVG chart and
a server-persisted light/dark theme.

## Quick start

```bash
npm run install:all   # install root, server, and client deps
npm run dev           # runs the API (:3001) and the Vite dev server (:5173)
```

Open http://localhost:5173

The Vite dev server proxies `/api/*` to the backend on port 3001.

### Production build

```bash
npm run build         # builds the client into client/dist
npm start             # serves API + built client on :3001
```

## Architecture

- **server/** — Express API.
  - `GET /api/summary` — total visitors, total revenue, best day, 7-day trend %.
  - `GET /api/timeseries` — 30 days of `{ day, visitors, revenue }`.
  - `GET /api/categories` — 6 categories `{ name, value }`.
  - `GET /api/recent` — 20 recent items.
  - `GET /api/settings` / `PUT /api/settings` — `{ theme: "light" | "dark" }`.
  - PGLite data is persisted under `server/pgdata/`; the schema is seeded
    deterministically on first boot (fixed PRNG seed + anchor date).
- **client/** — Vite single-page app. The chart is drawn from scratch in SVG and
  redraws on container resize via `ResizeObserver`.

## Responsive behavior

- `< 640px`: single column.
- `640–1023px`: two columns.
- `>= 1024px`: four stat cards in one row; chart + breakdown side by side; the
  recent-items table spans full width below.

No element causes horizontal page scroll at >= 360px. The table scrolls within
its own container rather than the page.
