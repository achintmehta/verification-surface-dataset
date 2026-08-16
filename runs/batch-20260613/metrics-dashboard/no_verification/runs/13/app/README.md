# Metrics Dashboard

A read-mostly analytics dashboard. A Node.js + Express server seeds and serves a
small metrics dataset from embedded PGLite; a Vanilla JS / Vite single-page app
renders it as a responsive dashboard with stat cards, a hand-drawn time-series
chart, a category breakdown, and a recent-items table. Includes a server-persisted
light/dark theme toggle.

## Structure

```
.
├── package.json        # root: runs server + client together
├── server/             # Express + PGLite API
│   └── src/
│       ├── index.js    # routes
│       └── db.js       # schema + deterministic seed
└── client/             # Vite + Vanilla JS frontend
    └── src/
        ├── main.js     # app bootstrap & rendering
        ├── chart.js    # hand-drawn responsive SVG line chart
        ├── api.js      # fetch client
        └── styles.css  # responsive grid + theme tokens
```

## Install

```bash
npm run install:all
```

## Run (dev)

```bash
npm run dev
```

- API:    http://localhost:3001
- Client: http://localhost:5173 (proxies `/api` to the server)

The database is seeded deterministically on first boot into `server/pgdata/`.

## API

| Method | Path             | Description                                            |
| ------ | ---------------- | ------------------------------------------------------ |
| GET    | `/api/summary`   | total visitors, total revenue, best day, 7-day trend % |
| GET    | `/api/timeseries`| 30 days of `{ day, visitors, revenue }`                |
| GET    | `/api/categories`| 6 categories `{ name, value }`                         |
| GET    | `/api/recent`    | 20 recent items                                        |
| GET    | `/api/settings`  | `{ theme }`                                            |
| PUT    | `/api/settings`  | persist `{ theme: "light" \| "dark" }`                 |

## Responsive behavior

- `< 640px`: single column.
- `640–1023px`: two columns (stat cards 2×2, chart + breakdown side by side).
- `≥ 1024px`: four stat cards in one row, chart and breakdown side by side below.

The page never scrolls horizontally at any width ≥ 360px. The chart redraws to
fit its container on resize. With the backend stopped, the page shows an explicit
error state with a retry button rather than stale content.
