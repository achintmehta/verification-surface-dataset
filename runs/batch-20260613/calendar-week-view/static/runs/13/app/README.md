# Week Calendar

A single-user week-view calendar. Node.js + Express + embedded PGLite backend,
Vanilla JS + Vite frontend. The defining feature is a correct cluster-based
overlap layout: any number of overlapping events render side-by-side, fully
visible, with minute-precise vertical geometry.

## Layout

```
.
├── package.json        # root scripts (run both dev servers together)
├── server/             # Express + PGLite JSON API
│   ├── package.json
│   └── src/
│       ├── index.js    # HTTP routes
│       ├── db.js       # PGLite init + schema (persists to server/data)
│       └── events.js   # validation + queries
└── web/                # Vite + Vanilla JS week view
    ├── package.json
    ├── index.html
    ├── vite.config.js  # proxies /api -> localhost:3001
    └── src/
        ├── main.js     # rendering + interaction
        ├── layout.js   # cluster overlap layout engine
        ├── dates.js    # local-time date helpers
        ├── api.js      # fetch wrappers
        ├── modal.js    # create/edit/delete form
        ├── styles.css  # geometry driven by --hour-height
        └── layout.test.js  # executable layout assertions
```

## Install & run

```bash
npm run install:all   # installs root, server, and web dependencies
npm run dev           # runs API (:3001) and Vite (:5173) together
```

Open http://localhost:5173.

- The server persists events with PGLite to `server/data/pgdata`, so data
  survives restarts.
- The Vite dev server proxies `/api/*` to the backend.

## API

- `GET /api/events?start=<iso>&end=<iso>` — events overlapping `[start, end)`.
- `POST /api/events` — `{ title, start_at, end_at }`; 400 if title empty or
  `end_at <= start_at`.
- `PUT /api/events/:id` — same validation.
- `DELETE /api/events/:id`.

## Overlap layout

See `web/src/layout.js`. Per day, events are grouped into transitive-overlap
clusters; within a cluster, columns are assigned greedily by start time; each
event's width is `1 / columnsUsed` and its left offset is `column / columnsUsed`.
Vertical `top`/`height` come directly from minutes-from-midnight mapped onto a
single axis-height constant (`--hour-height`). An event ending at 24:00 lands
exactly at the column's bottom edge. Run `node web/src/layout.test.js` to verify.
```
```
