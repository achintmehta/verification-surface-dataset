# Metrics Dashboard

A read-mostly analytics dashboard. A Node.js + Express server backed by an
embedded PGLite database serves a deterministically seeded metrics dataset as
JSON; a Vanilla JS + Vite single-page app renders it as a fully responsive
dashboard with hand-drawn (SVG) charts and a server-persisted light/dark theme.

## Structure

```
.
├── server/    Express + PGLite API
└── client/    Vite + Vanilla JS frontend
```

## Setup

```bash
# Install root tooling (concurrently) + workspace deps
npm install
npm run install:all
```

## Run (development)

Run both servers together:

```bash
npm run dev
```

- Server: http://localhost:3001
- Client: http://localhost:5173 (proxies `/api` to the server)

Or run them separately:

```bash
npm run dev:server
npm run dev:client
```

## API

| Method | Path             | Description                                              |
| ------ | ---------------- | ------------------------------------------------------- |
| GET    | `/api/summary`   | total visitors, total revenue, best day, 7-day trend %  |
| GET    | `/api/timeseries`| 30 days of `{date, visitors, revenue}`                  |
| GET    | `/api/categories`| 6 categories `{name, value}`                            |
| GET    | `/api/recent`    | 20 recent items `{name, category, value, created_at}`   |
| GET    | `/api/settings`  | `{ theme }`                                             |
| PUT    | `/api/settings`  | persist `{ theme: "light" | "dark" }`                   |

## Database

PGLite persists to `server/pgdata/`. On first boot the server creates the
schema and seeds it deterministically (fixed PRNG seed). Delete `server/pgdata/`
to re-seed from scratch. Theme preference is stored in the `settings` table, so
it survives both a page reload and a full server restart.

## Responsive behavior

- **< 640px**: single column.
- **640–1023px**: two columns (stat cards 2×2; chart and breakdown side by side).
- **≥ 1024px**: four stat cards in one row; chart and breakdown side by side below.

The page never scrolls horizontally at any width ≥ 360px. The SVG chart
re-renders to fit its container on every resize, and redraws its internals
(axes, gridlines, series) when the theme changes.
