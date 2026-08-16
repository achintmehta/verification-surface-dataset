# Metrics Dashboard

A read-mostly analytics dashboard. Node.js + Express + embedded PGLite backend
serving a deterministically seeded metrics dataset as JSON; a Vanilla JS / Vite
frontend renders it as a fully responsive dashboard with a hand-drawn SVG chart
and a server-persisted light/dark theme.

## Stack
- **Backend**: Express, `@electric-sql/pglite` (persists to `./.pgdata`), `cors`
- **Frontend**: Vanilla JS + Vite, hand-drawn SVG chart (no chart library)

## Run

```bash
npm install
npm run dev
```

- `npm run dev` runs the API (`:3001`) and Vite dev server (`:5173`) together.
- Open http://localhost:5173 — Vite proxies `/api/*` to the backend.

Individually:

```bash
npm run dev:server   # Express + PGLite on :3001
npm run dev:client   # Vite dev server on :5173
```

For a production-style single server:

```bash
npm run build        # builds the frontend to ./dist
npm start            # Express serves the API + ./dist on :3001
```

## API
- `GET /api/summary` — total visitors, total revenue, best day, 7-day trend %
- `GET /api/timeseries` — 30 days of `{ day, visitors, revenue }`
- `GET /api/categories` — 6 category rows `{ name, value }`
- `GET /api/recent` — 20 recent items `{ name, category, value, createdAt }`
- `GET /api/settings` / `PUT /api/settings` — `{ "theme": "light" | "dark" }`

## Data
Seeded deterministically on first boot into PGLite. The seed and any theme
change persist across a full server restart (stored on disk in `./.pgdata`).
Delete `.pgdata` to re-seed from scratch.

## Responsive layout
- `< 640px`: single column.
- `640–1023px`: two columns; table spans full width.
- `≥ 1024px`: four stat cards in one row; chart and breakdown side by side; table full width.

The page never scrolls sideways (`overflow-x: hidden` on the body, internal
scroll for the table). The chart re-renders to fit its container on resize via
a `ResizeObserver` and the window `resize` event.
