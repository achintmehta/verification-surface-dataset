# Metrics Dashboard

A read-mostly analytics dashboard. A Node.js + Express server seeds a small
metrics dataset into embedded **PGLite** and serves it as JSON. A Vanilla JS /
Vite single-page client renders it as a responsive dashboard: four summary stat
cards, a hand-drawn 30-day time-series line chart (no chart library), a category
breakdown, and a recent-items table — with a server-persisted light/dark theme.

## Structure

```
.
├── package.json        # root: runs server + client together
├── server/             # Express + PGLite API
│   └── src/
│       ├── index.js    # HTTP server + routes
│       └── db.js       # PGLite init + deterministic seed
└── client/             # Vite + Vanilla JS dashboard
    ├── index.html
    └── src/
        ├── main.js     # app bootstrap, layout, theming
        ├── chart.js    # hand-drawn responsive SVG chart
        ├── api.js
        └── styles.css  # responsive grid + theme tokens
```

## Install

```bash
npm run install:all
```

This installs the root tooling (`concurrently`) and each workspace's deps
(`express`, `@electric-sql/pglite`, `cors` on the server; `vite` on the client).

## Develop

```bash
npm run dev
```

- Server: http://localhost:3001 (API under `/api`)
- Client: http://localhost:5173 (proxies `/api` → server)

The database is seeded deterministically on the server's first boot into
`server/pgdata/`. Delete that directory to re-seed.

## Production-ish build

```bash
npm run build      # builds the client into client/dist
npm start          # server serves the API and the built client
```

## API

| Method | Path             | Description                                       |
| ------ | ---------------- | ------------------------------------------------- |
| GET    | `/api/summary`   | total visitors, total revenue, best day, 7-day %  |
| GET    | `/api/timeseries`| 30 days of `{ day, visitors, revenue }`           |
| GET    | `/api/categories`| 6 categories `{ name, value }`                    |
| GET    | `/api/recent`    | 20 recent items                                   |
| GET    | `/api/settings`  | `{ theme }`                                       |
| PUT    | `/api/settings`  | persist `{ theme: "light" \| "dark" }`            |

## Responsive behavior

- **< 640px**: single column; stat cards stack; table scrolls inside its own
  container (the page never scrolls sideways).
- **640–1023px**: two columns of stat cards; panels stacked.
- **≥ 1024px**: four stat cards in one row; chart and category breakdown side by
  side; recent table spans the full width beneath.

The chart redraws to fit its container on resize (via `ResizeObserver` +
window `resize`). The long seeded category label
(`Enterprise Infrastructure & Compliance`) truncates with an ellipsis, and the
seeded 7-digit category value renders fully without overflowing its card.
