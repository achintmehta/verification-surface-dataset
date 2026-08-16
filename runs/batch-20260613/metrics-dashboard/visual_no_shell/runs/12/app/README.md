# Metrics Dashboard

A read-mostly analytics dashboard. Express + embedded PGLite backend serving a
deterministically seeded metrics dataset; a Vanilla JS / Vite frontend rendering
a responsive dashboard with hand-drawn SVG charts and a server-persisted theme.

## Run

```bash
npm run install:all   # install server + client deps
npm run dev           # runs API (3001) and Vite dev server (5173) together
```

Open http://localhost:5173

## API

- `GET /api/summary` — total visitors, total revenue, best day, 7-day trend %
- `GET /api/timeseries` — 30 days of date/visitors/revenue
- `GET /api/categories` — 6 categories with values
- `GET /api/recent` — 20 recent items
- `GET /api/settings` / `PUT /api/settings` — `{ "theme": "light" | "dark" }`

The PGLite database is seeded on first boot into `server/pgdata/`.
