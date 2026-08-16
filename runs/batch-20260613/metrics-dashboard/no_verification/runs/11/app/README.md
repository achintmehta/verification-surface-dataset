# Metrics Dashboard

A read-mostly analytics dashboard: an Express + embedded **PGLite** backend that
seeds and serves a small metrics dataset as JSON, and a **Vanilla JS + Vite**
frontend that renders it as a responsive dashboard with a hand-drawn chart and a
server-persisted light/dark theme.

## Structure

```
.
├── server/   # Express + @electric-sql/pglite API
│   └── src/
│       ├── index.js   # API routes
│       ├── db.js      # PGLite init, schema, seeding
│       └── seed.js    # deterministic seed data
└── client/   # Vite + Vanilla JS dashboard
    ├── index.html
    └── src/
        ├── main.js    # fetch + render + theming
        ├── chart.js   # hand-drawn canvas time-series chart
        └── styles.css # responsive grid + theme variables
```

## Setup

```bash
npm install            # root (concurrently)
npm run install:all    # installs server + client deps
```

## Run (development)

```bash
npm run dev            # runs API (:4000) and Vite dev server (:5173) together
```

Then open http://localhost:5173. The Vite dev server proxies `/api/*` to the
backend on port 4000.

You can also run them separately:

```bash
npm run dev:server     # http://localhost:4000
npm run dev:client     # http://localhost:5173
```

## API

| Method | Path              | Description                                         |
| ------ | ----------------- | --------------------------------------------------- |
| GET    | `/api/summary`    | total visitors, total revenue, best day, 7-day trend|
| GET    | `/api/timeseries` | 30-day series (date, visitors, revenue)             |
| GET    | `/api/categories` | category breakdown                                  |
| GET    | `/api/recent`     | 20 recent items                                     |
| GET    | `/api/settings`   | `{ "theme": "light" \| "dark" }`                    |
| PUT    | `/api/settings`   | persist `{ "theme": "light" \| "dark" }`            |

## Data

The database (PGLite) is persisted to `server/pgdata/` and seeded
deterministically on first boot: 30 days of metrics, 6 categories (including the
long label "Enterprise Infrastructure & Compliance" and a value over 1,000,000),
and 20 recent items. The theme preference persists across reloads and server
restarts.

## Responsive layout

- `< 640px`: single column.
- `640–1023px`: two columns; the table spans the full width.
- `>= 1024px`: four stat cards across the top, chart and category breakdown side
  by side, table spanning the full width below.

The chart redraws to fit its container (DPR-aware) on every resize, and the
entire palette — including chart axes, gridlines, and series — restyles with the
theme.
