# Metrics Dashboard

A read-mostly analytics dashboard built as a traditional client-server web app.

- **Backend** — Node.js + Express + embedded [PGLite](https://github.com/electric-sql/pglite). Seeds a deterministic dataset on first boot and serves it as JSON.
- **Frontend** — Vanilla JS + Vite single-page dashboard with a hand-drawn (SVG) chart and a responsive CSS-Grid layout. No charting library.

## Quick start

```bash
npm install      # installs root, server, and client deps
npm run dev      # runs the Express API (:4000) and the Vite dev server (:5173) together
```

Then open <http://localhost:5173>. The Vite dev server proxies `/api/*` to the backend on port 4000.

## Architecture

### Backend (`server/`)

- `src/db.js` — initializes PGLite (persisted to `server/.pgdata/`), creates the schema, and seeds it **deterministically** with a fixed-seed PRNG:
  - `daily_metrics` — 30 days of `(day, visitors, revenue)`
  - `categories` — 6 rows including the long label *"Enterprise Infrastructure & Compliance"* and a value ≥ 1,000,000
  - `recent_items` — 20 rows `(name, category, value, created_at)`
  - `settings` — singleton row holding the `theme`
- `src/index.js` — Express app with CORS + JSON parsing and the API:
  - `GET /api/summary` → `{ totalVisitors, totalRevenue, bestDay, trend7d }`
  - `GET /api/timeseries` → 30-day series
  - `GET /api/categories` → category breakdown
  - `GET /api/recent` → recent items
  - `GET /api/settings` / `PUT /api/settings` → `{ theme: "light" | "dark" }`

### Frontend (`client/`)

- `index.html` — applies the persisted theme **before first paint** (fetches `/api/settings`).
- `src/main.js` — fetches all data, renders stat cards / breakdown / table, wires the theme toggle, and shows an explicit error state with a Retry button when the API is unreachable.
- `src/chart.js` — hand-drawn responsive SVG line chart. Uses a `ResizeObserver` + `window.resize` listener to redraw and exactly fit its container at every width. Colors come from CSS variables so the chart restyles with the theme.
- `src/styles.css` — CSS-Grid responsive layout and the light/dark palettes.

## Responsive behaviour

- `< 640px` — single column; everything stacks.
- `640–1023px` — two columns; stat cards in a 2×2, chart and breakdown side by side.
- `≥ 1024px` — four stat cards in one row; chart and breakdown side by side below; the recent-items table spans full width.

No horizontal page scroll at any width ≥ 360px. Long category names truncate with an ellipsis; the recent-items table scrolls within its own card rather than forcing the page sideways.
