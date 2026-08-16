# Metrics Dashboard

A read-mostly analytics dashboard. A Node.js + Express + embedded PGLite backend
seeds and serves a small metrics dataset; a Vanilla JS / Vite frontend renders it
as a responsive dashboard with hand-drawn SVG charts and a server-persisted theme.

## Structure

```
backend/   Express API + PGLite (deterministic seed in src/db.js)
frontend/  Vite single-page dashboard (vanilla JS, hand-drawn SVG chart)
```

## Setup

```bash
npm run install:all
```

## Develop (backend + frontend together)

```bash
npm run dev
```

- Backend API: http://localhost:3001
- Frontend (Vite, proxies `/api` to the backend): http://localhost:5173

## Production-style run

```bash
npm run build          # builds frontend/dist
npm start              # backend serves the API and the built frontend on :3001
```

## API

| Method | Path             | Description                                              |
| ------ | ---------------- | -------------------------------------------------------- |
| GET    | `/api/summary`   | total visitors, total revenue, best day, 7-day trend %   |
| GET    | `/api/timeseries`| 30 days of `{ day, visitors, revenue }`                  |
| GET    | `/api/categories`| 6 categories `{ id, name, value }`                       |
| GET    | `/api/recent`    | 20 recent items `{ id, name, category, value, created_at }` |
| GET    | `/api/settings`  | `{ theme }`                                              |
| PUT    | `/api/settings`  | persist `{ theme: "light" \| "dark" }`                   |

## Notes

- The database is seeded deterministically on first boot into `backend/pgdata/`.
  Delete that directory to force a fresh re-seed.
- The chart is drawn with our own SVG code and re-renders to fit its container on
  resize (via `ResizeObserver`).
- The theme preference round-trips through `PUT /api/settings` and survives a full
  server restart.
