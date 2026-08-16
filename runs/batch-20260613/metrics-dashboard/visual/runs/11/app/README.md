# Metrics Dashboard

A read-mostly analytics dashboard built as a traditional client–server web app.

- **Backend**: Node.js + Express + embedded [PGLite](https://github.com/electric-sql/pglite). Seeds a deterministic metrics dataset on first boot and serves it as JSON. Persists the theme preference server-side.
- **Frontend**: Vanilla JS + Vite single-page dashboard with a hand-drawn (canvas) time-series chart and a fully responsive CSS Grid layout.

## Layout

- 4 summary stat cards
- 30-day visitors line chart (drawn on a `<canvas>`, redraws to fit its container on resize)
- Category breakdown horizontal bars (long labels truncate with ellipsis)
- Recent-items table (scrolls internally on narrow screens — no page-level horizontal scroll)

### Responsive breakpoints

| Width            | Stat cards | Body panels                          |
| ---------------- | ---------- | ------------------------------------ |
| `< 640px`        | 1 column   | 1 column (stacked)                   |
| `640px–1023px`   | 2 columns  | 2 columns; table full-width          |
| `>= 1024px`      | 4 in a row | chart + breakdown side by side; table full-width |

## API

| Method | Path              | Description                                            |
| ------ | ----------------- | ----------------------------------------------------- |
| GET    | `/api/summary`    | total visitors, total revenue, best day, 7-day trend% |
| GET    | `/api/timeseries` | 30 days of `{ day, visitors, revenue }`               |
| GET    | `/api/categories` | 6 categories `{ name, value }`                        |
| GET    | `/api/recent`     | 20 recent items                                       |
| GET    | `/api/settings`   | `{ theme: "light" | "dark" }`                         |
| PUT    | `/api/settings`   | persist `{ theme }`                                   |

## Running

Install all dependencies (root, server, client):

```bash
npm run install:all
```

Run backend (port 3001) and frontend (port 5173) together:

```bash
npm run dev
```

Then open http://localhost:5173. The Vite dev server proxies `/api` to the backend.

The PGLite database is stored in `server/pgdata/`. Delete that folder to re-seed.
