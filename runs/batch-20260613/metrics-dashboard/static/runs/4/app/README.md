# Metrics Dashboard

A read-mostly analytics dashboard built with Node.js + Express + PGLite (backend) and Vanilla JS + Vite (frontend).

## Architecture

```
metrics-dashboard/
├── server/          # Express + PGLite backend
│   ├── src/
│   │   ├── index.js          # Entry point
│   │   ├── db.js             # PGLite initialisation
│   │   ├── seed.js           # Deterministic seed (LCG, fixed seed 0xdeadbeef)
│   │   └── routes/
│   │       ├── summary.js    # GET /api/summary
│   │       ├── timeseries.js # GET /api/timeseries
│   │       ├── categories.js # GET /api/categories
│   │       ├── recent.js     # GET /api/recent
│   │       └── settings.js   # GET/PUT /api/settings
│   └── data/                 # PGLite data directory (created on first run)
│
└── client/          # Vite + Vanilla JS frontend
    ├── index.html
    └── src/
        ├── main.js           # Bootstrap & orchestration
        ├── api.js            # Fetch wrappers
        ├── theme.js          # Theme toggle & persistence
        ├── components/
        │   ├── statCards.js       # Four summary stat cards
        │   ├── timeseriesChart.js # Hand-drawn canvas chart
        │   ├── categoryBars.js    # Horizontal bar breakdown
        │   └── recentTable.js     # Recent items table
        ├── utils/
        │   └── format.js     # Number/date formatters
        └── styles/
            └── main.css      # CSS custom properties + responsive grid
```

## Getting Started

### Prerequisites

- Node.js 18+
- npm 9+

### Install

```bash
npm install
```

This installs dependencies for the root workspace, server, and client.

### Development

Run both servers concurrently:

```bash
npm run dev
```

- Backend: http://localhost:3001
- Frontend: http://localhost:5173 (proxies `/api` to the backend)

### Production Build

```bash
npm run build   # builds client into server/public/
npm run start   # serves everything from the Express server
```

## API Endpoints

| Method | Path              | Description                          |
|--------|-------------------|--------------------------------------|
| GET    | /api/summary      | Four headline numbers                |
| GET    | /api/timeseries   | 30-day daily metrics array           |
| GET    | /api/categories   | 6 categories sorted by value desc    |
| GET    | /api/recent       | 20 most recent items                 |
| GET    | /api/settings     | `{ theme: "light" \| "dark" }`       |
| PUT    | /api/settings     | Persist theme preference             |
| GET    | /api/health       | `{ ok: true }`                       |

## Responsive Breakpoints

| Viewport  | Stat cards | Body layout          |
|-----------|------------|----------------------|
| < 640px   | 1 column   | 1 column             |
| 640–1023px| 2 columns  | 1 column             |
| ≥ 1024px  | 4 columns  | Chart + Breakdown 3:2|

## Seed Data

The database is seeded deterministically on first boot using an LCG with seed `0xdeadbeef`:

- **daily_metrics**: 30 rows (date, visitors 800–5000, revenue $500–$4000)
- **categories**: 6 rows including:
  - "Enterprise Infrastructure & Compliance" (long label, value $1,284,750)
  - 5 other categories with random values
- **recent_items**: 20 rows with names, categories, values, and timestamps
- **settings**: `{ theme: "light" }` default

## Theme

The light/dark theme preference is persisted server-side in PGLite and applied before first paint to avoid flash. Toggle with the ☀️/🌙 button in the header.
