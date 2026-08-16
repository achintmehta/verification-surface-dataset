# Week Calendar

A single-user, week-view calendar. 7 day columns (Monday–Sunday) against a
continuous 00:00–24:00 time axis. Events are created/edited/deleted with
minute-precision times, persisted server-side in embedded PostgreSQL (PGLite),
and laid out with a cluster-based overlap engine so that **no event block ever
covers another**.

## Stack

- **Backend**: Node.js + Express + `@electric-sql/pglite` (embedded Postgres,
  persisted to disk) + `cors`.
- **Frontend**: Vanilla JS + Vite. The overlap layout engine lives in
  `frontend/src/layout.js` and is a pure function of the data.

## Layout

```
project/
  package.json          # root: runs backend + frontend together
  backend/
    src/server.js       # Express app + routes
    src/db.js           # PGLite init + schema
    src/events.js       # queries + validation
  frontend/
    index.html
    vite.config.js      # proxies /api -> http://localhost:3001
    src/main.js         # week grid rendering + interaction
    src/layout.js       # cluster overlap layout (pure)
    src/time.js         # date/time helpers
    src/api.js          # JSON API client
```

## Install & run

```bash
npm run install:all     # installs root + backend + frontend deps
npm run dev             # runs backend (3001) and frontend (5173) together
```

Open http://localhost:5173.

You can also run them separately:

```bash
npm run dev:backend
npm run dev:frontend
```

## API

- `GET /api/events?start=<iso>&end=<iso>` — events overlapping the range.
- `POST /api/events` — `{ title, start_at, end_at }`. 400 on empty title or
  `end_at <= start_at`.
- `PUT /api/events/:id` — same body/validation as POST.
- `DELETE /api/events/:id` — 204 on success.

## Persistence

PGLite writes to `backend/data/pgdata`. Events survive a server restart and a
page reload.

## Layout engine

For each day, events are clamped to `[00:00, 24:00)` minute offsets and grouped
into maximal transitively-overlapping **clusters**. Within a cluster, columns
are assigned greedily by start time; each event's width is `1 / columns` of the
day-column width and its left offset is `column / columns`. Non-contended
events form 1-column clusters and take the full width. Vertical position and
height come directly from the times via a single `HOUR_HEIGHT` constant, so an
event ending at 24:00 ends exactly at the bottom edge.

Hand-checkable fixtures: `node frontend/src/layout.test-fixtures.js`.
