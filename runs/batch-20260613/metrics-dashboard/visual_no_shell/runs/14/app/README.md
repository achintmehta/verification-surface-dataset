# Metrics Dashboard

A read-mostly analytics dashboard. Express + embedded PGLite backend serving a
deterministically-seeded metrics dataset as JSON, with a Vanilla JS / Vite
frontend that renders a fully responsive dashboard with a hand-drawn SVG chart
and a server-persisted light/dark theme.

## Run

```bash
npm run install:all   # installs root, server, and client deps
npm run dev           # starts API (:3001) and Vite dev server (:5173) together
```

Open http://localhost:5173.

The Vite dev server proxies `/api/*` to the backend on port 3001.

## API

- `GET /api/summary` — total visitors, total revenue, best day, 7-day trend %
- `GET /api/timeseries` — 30 days of `{ day, visitors, revenue }`
- `GET /api/categories` — 6 categories `{ id, name, value }`
- `GET /api/recent` — 20 recent items
- `GET /api/settings` / `PUT /api/settings` — `{ theme: "light" | "dark" }`

## Notes

- PGLite persists to `server/pgdata/`. The schema is seeded once on first boot
  with a fixed PRNG seed, so the dataset (and theme persistence) survives full
  server restarts.
- The chart is drawn with our own SVG code and redraws on container resize via
  `ResizeObserver`; it reads theme colors from CSS custom properties.
- Layout breakpoints: 1 column < 640px, 2 columns 640–1023px, 4 stat cards in a
  row with chart + breakdown side-by-side at ≥ 1024px.
