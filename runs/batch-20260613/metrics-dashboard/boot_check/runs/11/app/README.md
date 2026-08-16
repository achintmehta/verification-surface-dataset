# Metrics Dashboard

A read-mostly analytics dashboard. Express + embedded PGLite backend serving a
deterministically-seeded metrics dataset as JSON; a Vanilla JS / Vite frontend
rendering a responsive dashboard with a hand-drawn SVG chart and a
server-persisted light/dark theme.

## Layout

```
.
├── server/            Express + PGLite backend
│   ├── index.js       entry shim -> src/index.js
│   └── src/
│       ├── index.js   express app + routes + listen
│       └── db.js      PGLite init, schema, deterministic seed
├── client/            Vite + Vanilla JS frontend
│   ├── index.html
│   └── src/
│       ├── main.js    data load, render, theme toggle
│       ├── chart.js   self-contained, resize-aware SVG line chart
│       └── styles.css responsive grid + theming via CSS variables
├── index.js           root entry shim -> backend
└── package.json       workspace scripts
```

## Run (development)

```bash
npm run install:all      # install root, server, and client deps
npm run dev              # run backend (:3001) and frontend (:5173) together
```

Open http://localhost:5173 — the Vite dev server proxies `/api/*` to the backend.

Run pieces individually:

```bash
npm run dev:server       # backend only on :3001
npm run dev:client       # frontend only on :5173
```

## Run (production)

```bash
npm run build            # build the client into client/dist
npm start                # backend serves the API and the built client on :3001
```

## API

| Method | Path             | Description                                            |
|--------|------------------|--------------------------------------------------------|
| GET    | `/api/summary`   | total visitors, total revenue, best day, 7-day trend % |
| GET    | `/api/timeseries`| 30 days of `{ day, visitors, revenue }`                |
| GET    | `/api/categories`| 6 categories `{ id, name, value }`                     |
| GET    | `/api/recent`    | 20 recent items                                        |
| GET    | `/api/settings`  | `{ theme: "light" \| "dark" }`                         |
| PUT    | `/api/settings`  | persist `{ theme }`                                    |

Data persists in `server/pgdata/` (created on first boot). The seed is
deterministic (fixed PRNG seed + anchor date), so values are reproducible. One
category uses a deliberately long label and a value > 1,000,000 to exercise
truncation and large-number rendering.

## Responsive behaviour

- `< 640px`: single column; stat cards stack.
- `640–1023px`: two columns; stat cards 2×2.
- `>= 1024px`: four stat cards in one row; chart and breakdown side by side.

No horizontal page scroll at any width ≥ 360px. The chart redraws to fit its
container (ResizeObserver + window resize) and follows the active theme. If the
backend is unreachable the page shows an explicit error state instead of stale
content.
