# Metrics Dashboard

A read-mostly analytics dashboard. Node.js + Express + embedded PGLite serve a
deterministically seeded metrics dataset as JSON; a Vanilla JS / Vite SPA renders
it as a responsive dashboard with a hand-drawn SVG chart and a server-persisted
light/dark theme.

## Structure

```
.
├── package.json        # root scripts (run server + client together)
├── server/             # Express + PGLite API
│   └── src/
│       ├── index.js    # routes
│       └── db.js       # schema + deterministic seed
└── client/             # Vite + Vanilla JS frontend
    └── src/
        ├── main.js     # app shell, rendering, theme
        ├── chart.js    # hand-drawn responsive SVG line chart
        ├── api.js      # fetch wrappers
        ├── format.js   # number/date formatting
        └── styles.css  # responsive grid + theme tokens
```

## Setup

```bash
npm run install:all
```

## Run (development)

```bash
npm run dev
```

- API: http://localhost:3001
- App: http://localhost:5173 (proxies `/api` to the backend)

On first boot the server creates `server/pgdata/` and seeds:

- `daily_metrics` — 30 days (date, visitors, revenue)
- `categories` — 6 rows including one long label and a 7-digit value
- `recent_items` — 20 rows
- `settings` — theme preference

The seed is deterministic (fixed PRNG seed `1337`), so the dashboard renders
identically on every fresh boot. Delete `server/pgdata/` to reseed.

## API

| Method | Path              | Description                                        |
| ------ | ----------------- | -------------------------------------------------- |
| GET    | `/api/summary`    | total visitors, total revenue, best day, 7-day trend |
| GET    | `/api/timeseries` | 30 days of `{ day, visitors, revenue }`            |
| GET    | `/api/categories` | `{ name, value }` per category                     |
| GET    | `/api/recent`     | 20 recent items                                    |
| GET    | `/api/settings`   | `{ theme }`                                         |
| PUT    | `/api/settings`   | persist `{ theme: "light" \| "dark" }`             |

## Responsive behaviour

- **< 640px:** single column.
- **640–1023px:** two columns; stat cards 2×2.
- **≥ 1024px:** four stat cards in one row; chart and breakdown side by side;
  recent-items table spans full width below.

No horizontal page scroll at any width ≥ 360px. The chart redraws to fit its
container on resize via a `ResizeObserver`. The recent-items table scrolls
within its own card rather than forcing the page sideways.
