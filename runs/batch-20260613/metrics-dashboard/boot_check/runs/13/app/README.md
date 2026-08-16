# Metrics Dashboard

A read-mostly analytics dashboard. A Node.js + Express server backed by embedded
**PGLite** seeds a deterministic dataset and serves it as JSON; a Vanilla JS /
Vite single-page frontend renders it as a responsive dashboard with
hand-drawn charts and a server-persisted light/dark theme.

## Architecture

```
app/
├── index.js          # root server entry (delegates to server/src/index.js)
├── server.js         # alternate root server entry (same delegation)
├── server/           # Express + PGLite backend
│   └── src/
│       ├── index.js  # Express app + JSON API
│       └── db.js     # PGLite init, schema, deterministic seed
└── client/           # Vite vanilla-JS frontend
    ├── index.html
    └── src/
        ├── main.js   # data fetching + DOM rendering + theme
        ├── chart.js  # hand-drawn canvas time-series chart
        └── styles.css# responsive grid + theme tokens
```

## Install

```bash
npm run install:all   # installs server + client dependencies
```

## Run (development)

```bash
npm run dev           # runs backend (:3001) and Vite frontend (:5173) together
```

Then open http://localhost:5173. The Vite dev server proxies `/api/*` to the
backend on port 3001.

You can also run them separately:

```bash
npm run dev:server    # backend only, http://localhost:3001
npm run dev:client    # frontend only, http://localhost:5173
```

## API

| Method | Path              | Description                                            |
| ------ | ----------------- | ------------------------------------------------------ |
| GET    | `/api/summary`    | total visitors, total revenue, best day, 7-day trend % |
| GET    | `/api/timeseries` | 30 days of `{ date, visitors, revenue }`               |
| GET    | `/api/categories` | 6 categories `{ name, value }` (desc by value)         |
| GET    | `/api/recent`     | 20 recent items `{ name, category, value, createdAt }` |
| GET    | `/api/settings`   | `{ theme: "light" \| "dark" }`                         |
| PUT    | `/api/settings`   | persist `{ theme }`                                    |

## Data & persistence

The database is seeded **deterministically** on first boot (fixed PRNG seed)
and persisted to `server/data/pgdata`. The theme preference is stored in the
`settings` table, so it survives both page reloads and full server restarts.

## Responsive behavior

- `< 640px`: single column.
- `640–1023px`: two columns; stat cards 2×2.
- `≥ 1024px`: four stat cards in one row, with the chart and category
  breakdown side by side below.

The chart is drawn on a `<canvas>` by our own code and redraws (via
`ResizeObserver` + window `resize`) to fit its container at any width, staying
crisp on HiDPI displays. There is no horizontal page scroll at any width ≥ 360px.
If the backend is unreachable, the page shows an explicit error state instead of
stale content.
