# Metrics Dashboard

A responsive analytics dashboard built with Node.js + Express + PGLite (backend) and Vanilla JS + Vite (frontend).

## Architecture

```
metrics-dashboard/
├── package.json          # Root workspace (concurrently)
├── server/               # Express + PGLite backend
│   ├── package.json
│   └── src/
│       ├── index.js      # Server entry point
│       ├── db.js         # PGLite init + deterministic seed
│       └── routes/
│           ├── summary.js
│           ├── timeseries.js
│           ├── categories.js
│           ├── recent.js
│           └── settings.js
└── client/               # Vanilla JS + Vite frontend
    ├── package.json
    ├── vite.config.js
    ├── index.html
    └── src/
        ├── main.js       # Dashboard orchestration
        ├── chart.js      # Hand-drawn SVG line chart
        ├── format.js     # Number/date formatting
        └── styles/
            └── main.css  # Responsive CSS Grid layout + theming
```

## Running

### Development (both servers)

```bash
npm install
npm run dev
```

- Frontend: http://localhost:5173
- Backend API: http://localhost:3001

### Production

```bash
npm install
npm run build    # builds client into client/dist/
npm run start    # serves API + static files on port 3001
```

## API Endpoints

| Method | Path              | Description                          |
|--------|-------------------|--------------------------------------|
| GET    | /api/summary      | Four headline numbers                |
| GET    | /api/timeseries   | 30-day daily metrics                 |
| GET    | /api/categories   | Category breakdown (6 rows)          |
| GET    | /api/recent       | 20 most recent items                 |
| GET    | /api/settings     | Current theme preference             |
| PUT    | /api/settings     | Update theme (`{ theme: "light" \| "dark" }`) |

## Database

PGLite writes to `.pglite-data/` in the project root. On first boot the database is seeded deterministically (fixed PRNG seed `0xdeadbeef`) with:

- **30 days** of `daily_metrics` (date, visitors 500–5000, revenue $1000–$10000)
- **6 categories** including "Enterprise Infrastructure & Compliance" (long label) and one value ≥ 1,000,000
- **20 recent items** with names, categories, values, and timestamps
- **settings** row with `theme = 'light'`

## Responsive Breakpoints

| Viewport | Stat cards | Body layout |
|----------|-----------|-------------|
| < 640px  | 1 column  | 1 column    |
| 640–1023px | 2 columns | 1 column  |
| ≥ 1024px | 4 columns | Chart (3fr) + Breakdown (2fr) |

## Chart

The time-series chart is drawn entirely in SVG with no external library:
- Y-axis with "nice" rounded tick values (1k, 2.5k, 5k …)
- X-axis with adaptive tick count (fits without overlapping)
- Area fill + line + dot on last point
- Clip-path prevents drawing outside the plot area
- ResizeObserver redraws on every container size change
- All colours read from CSS custom properties → theme-aware
