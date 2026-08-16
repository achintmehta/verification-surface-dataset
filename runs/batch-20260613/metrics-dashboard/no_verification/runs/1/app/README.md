# Metrics Dashboard

A responsive analytics dashboard built with Node.js + Express + PGLite (backend) and Vanilla JS + Vite (frontend).

## Project Structure

```
metrics-dashboard/
├── package.json          # Root package with all deps + npm scripts
├── vite.config.js        # Vite config (root: 'client', proxy: /api → :3001)
├── server/
│   ├── index.js          # Express server + API routes
│   └── db.js             # PGLite init, schema, deterministic seed
├── client/
│   ├── index.html        # SPA entry point (inline theme pre-paint script)
│   └── src/
│       ├── main.js       # Dashboard bootstrap, render functions
│       ├── api.js        # Fetch wrapper for all API calls
│       ├── chart.js      # Hand-drawn canvas time-series chart
│       └── styles/
│           └── main.css  # CSS custom properties, responsive grid, themes
└── data/
    └── pglite/           # PGLite data directory (created on first boot)
```

## Getting Started

```bash
npm install
npm run dev        # starts both server (:3001) and Vite dev server (:5173)
```

Open http://localhost:5173 in your browser.

### Individual servers

```bash
npm run dev:server   # Express + PGLite on :3001
npm run dev:client   # Vite dev server on :5173 (proxies /api to :3001)
```

### Production build

```bash
npm run build        # Vite builds client to ./dist
npm start            # Express serves on :3001 (serve dist separately or add static middleware)
```

## API Endpoints

| Method | Path              | Description                              |
|--------|-------------------|------------------------------------------|
| GET    | /api/summary      | Four headline numbers                    |
| GET    | /api/timeseries   | 30-day daily metrics (date, visitors, revenue) |
| GET    | /api/categories   | 6 categories sorted by value desc        |
| GET    | /api/recent       | 20 most recent items                     |
| GET    | /api/settings     | `{ theme: "light" \| "dark" }`           |
| PUT    | /api/settings     | Body: `{ theme: "light" \| "dark" }`     |

## Responsive Breakpoints

| Width       | Layout                                              |
|-------------|-----------------------------------------------------|
| < 640px     | 1 column — all sections stacked                     |
| 640–1023px  | 2 columns — stat cards 2×2, body sections stacked   |
| ≥ 1024px    | 4 stat cards in one row; chart (3fr) + categories (2fr) side by side |

## Features

- **Hand-drawn SVG/Canvas chart** — no chart library; ResizeObserver redraws on container resize
- **Light/dark theme toggle** — persisted server-side in PGLite, applied before first paint
- **Deterministic seed** — fixed LCG seed produces identical data on every fresh boot
- **No horizontal overflow** — `overflow-x: hidden` on root + `min-width: 0` on all grid children
- **Long label truncation** — "Enterprise Infrastructure & Compliance" truncates with ellipsis in category bars
- **7-digit value** — $1,284,500 renders fully on its stat card
- **Error state** — when backend is unreachable, explicit error banner shown instead of stale content
