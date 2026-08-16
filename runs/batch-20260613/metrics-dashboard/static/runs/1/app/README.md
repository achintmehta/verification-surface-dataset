# Metrics Dashboard

A read-mostly analytics dashboard built with Node.js + Express + PGLite (embedded PostgreSQL) on the backend, and Vanilla JS + Vite on the frontend.

## Features

- **Four summary stat cards**: total visitors, total revenue, best day, 7-day trend
- **30-day time-series line chart**: hand-drawn SVG, redraws on resize
- **Category breakdown**: horizontal bars with value labels; long names truncate with ellipsis
- **Recent items table**: responsive, no horizontal page scroll
- **Light/dark theme toggle**: persisted server-side in PGLite, survives reload and restart
- **Fully responsive**: 1 column (≤639px), 2 columns (640–1023px), 4-across cards + 2-column body (≥1024px)

## Quick Start

### Prerequisites

- Node.js 18+
- npm 9+

### Install

```bash
npm install
```

### Development (both servers)

```bash
npm run dev
```

- Backend: http://localhost:3001
- Frontend: http://localhost:5173 (proxies `/api/*` to the backend)

### Production

```bash
npm run build   # builds client into server/public/
npm run start   # serves everything from the Express server
```

## Project Structure

```
├── package.json          # workspace root
├── server/
│   ├── package.json
│   ├── src/
│   │   ├── index.js      # Express app entry point
│   │   ├── db.js         # PGLite init, schema, deterministic seed
│   │   └── routes/
│   │       ├── summary.js
│   │       ├── timeseries.js
│   │       ├── categories.js
│   │       ├── recent.js
│   │       └── settings.js
│   └── data/             # PGLite database files (auto-created)
└── client/
    ├── package.json
    ├── vite.config.js
    ├── index.html
    └── src/
        ├── main.js       # boot sequence
        ├── api.js        # fetch wrapper
        ├── cards.js      # stat card renderer
        ├── chart.js      # hand-drawn SVG chart
        ├── categories.js # bar chart renderer
        ├── table.js      # recent items table
        ├── theme.js      # theme toggle + persistence
        ├── utils/
        │   └── format.js # number/date formatters
        └── styles/
            └── main.css  # all styles, CSS custom properties
```

## API

| Method | Path              | Description                          |
|--------|-------------------|--------------------------------------|
| GET    | /api/summary      | Four headline numbers                |
| GET    | /api/timeseries   | 30 daily rows (date, visitors, revenue) |
| GET    | /api/categories   | 6 category rows (name, value)        |
| GET    | /api/recent       | 20 most recent items                 |
| GET    | /api/settings     | `{ "theme": "light" \| "dark" }`     |
| PUT    | /api/settings     | Body: `{ "theme": "light" \| "dark" }` |

## Seed Data

On first boot the database is seeded deterministically (fixed PRNG seed `0xdeadbeef`):

- **30 days** of daily metrics (visitors 800–5000, revenue $50–$1000/day)
- **6 categories** including `"Enterprise Infrastructure & Compliance"` (long name) with value `$1,234,567.89` (≥7 digits)
- **20 recent items** spread over the last 20 days
- **Settings** defaulting to `light` theme

## Acceptance Criteria

- ✅ Layout correct at 360px, 768px, 1280px — no horizontal scroll, no clipped elements
- ✅ Chart fits container at all widths, redraws on resize
- ✅ Long category name truncates with ellipsis; 7-digit value renders fully
- ✅ Stat card numbers match API values
- ✅ Theme toggle restyles entire dashboard; preference survives reload and server restart
- ✅ With backend stopped: explicit error state shown, no stale hardcoded content
