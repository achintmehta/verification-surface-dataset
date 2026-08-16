# Metrics Dashboard

A responsive analytics dashboard built with:
- **Backend**: Node.js + Express + PGLite (embedded PostgreSQL)
- **Frontend**: Vanilla JS + Vite (no chart libraries — hand-drawn Canvas charts)

## Quick Start

### Install dependencies

```bash
npm install
```

### Run both servers together (development)

```bash
npm run dev
```

- Backend API: http://localhost:3001
- Frontend dev server: http://localhost:5173

### Run backend only

```bash
npm run start
```

## Architecture

```
metrics-dashboard/
├── server/                  # Express + PGLite backend
│   ├── src/
│   │   ├── index.js         # Server entry point
│   │   ├── db.js            # PGLite init, schema, deterministic seed
│   │   └── routes/
│   │       ├── summary.js   # GET /api/summary
│   │       ├── timeseries.js# GET /api/timeseries
│   │       ├── categories.js# GET /api/categories
│   │       ├── recent.js    # GET /api/recent
│   │       └── settings.js  # GET/PUT /api/settings
│   └── package.json
├── client/                  # Vite + Vanilla JS frontend
│   ├── index.html
│   ├── src/
│   │   ├── main.js          # App bootstrap, render logic
│   │   ├── api.js           # Fetch wrappers
│   │   ├── chart.js         # Hand-drawn Canvas time-series chart
│   │   ├── formatters.js    # Number/date formatting
│   │   └── styles/
│   │       └── main.css     # CSS custom properties, responsive grid
│   ├── vite.config.js
│   └── package.json
└── package.json             # Workspace root with concurrently
```

## API Endpoints

| Method | Path              | Description                              |
|--------|-------------------|------------------------------------------|
| GET    | /api/summary      | Four headline numbers                    |
| GET    | /api/timeseries   | 30-day daily visitors + revenue          |
| GET    | /api/categories   | 6 categories with values                 |
| GET    | /api/recent       | 20 most recent items                     |
| GET    | /api/settings     | Current theme preference                 |
| PUT    | /api/settings     | Update theme `{ "theme": "light"|"dark"}`|
| GET    | /api/health       | Health check                             |

## Responsive Breakpoints

| Width       | Layout                                              |
|-------------|-----------------------------------------------------|
| < 640px     | 1 column (all sections stacked)                     |
| 640–1023px  | 2 columns for stat cards; chart/categories stacked  |
| ≥ 1024px    | 4 stat cards in one row; chart (3/5) + categories (2/5) side by side |

## Features

- **Deterministic seed**: Fixed PRNG seed (`0xdeadbeef`) ensures reproducible data
- **Hand-drawn chart**: Canvas 2D with ResizeObserver — redraws on every container resize
- **Theme persistence**: Light/dark preference stored in PGLite, survives server restart
- **No horizontal overflow**: `overflow-x: hidden` on body; table uses internal scroll
- **Error state**: When backend is unreachable, an explicit error banner is shown
