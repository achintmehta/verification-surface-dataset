# Metrics Dashboard

A read-mostly analytics dashboard built as a traditional client/server web app.

- **Backend:** Node.js + Express + embedded [PGLite](https://github.com/electric-sql/pglite),
  deterministically seeded on first boot, serving metrics and settings as JSON.
- **Frontend:** Vite + Vanilla JS single-page dashboard with a hand-drawn SVG
  chart and a responsive CSS-Grid layout.

## Layout

```
.
├── package.json        # orchestration scripts (dev runs both servers)
├── server/             # Express + PGLite API
│   ├── index.js        # server entry (node server/index.js)
│   └── src/db.js       # PGLite init, schema, deterministic seed
└── client/             # Vite + Vanilla JS frontend
    ├── index.html
    └── src/{main,api,chart}.js + styles.css
```

## Install & run (development)

```bash
npm install            # installs root + server + client deps (postinstall)
npm run dev            # runs API (:3001) and Vite dev server (:5173) together
```

Open http://localhost:5173. The Vite dev server proxies `/api/*` to the backend.

## Production

```bash
npm run build          # builds the client into client/dist
npm start              # serves the API and the built client from :3001
```

## API

| Method | Path              | Description                                            |
| ------ | ----------------- | ------------------------------------------------------ |
| GET    | `/api/summary`    | total visitors, total revenue, best day, 7-day trend % |
| GET    | `/api/timeseries` | 30 days of `{date, visitors, revenue}`                 |
| GET    | `/api/categories` | 6 categories `{name, value}`                           |
| GET    | `/api/recent`     | 20 recent items                                        |
| GET    | `/api/settings`   | `{ theme }`                                            |
| PUT    | `/api/settings`   | persist `{ theme: "light" \| "dark" }`                 |

## Notes

- The dataset is seeded once with a fixed PRNG seed, so any two boots render the
  same dashboard. Delete `server/pgdata/` to force a re-seed.
- The theme preference is persisted server-side in PGLite and applied before
  first paint on reload.
- The chart is drawn entirely in our own SVG code and re-renders on container
  resize via a `ResizeObserver`.
- With the backend stopped, the page shows an explicit error state (with a
  Retry button) rather than stale content.
