# Week Calendar

A single-user week-view calendar. 7 day columns (Mon–Sun) over a continuous
00:00–24:00 time axis, with create/edit/delete of minute-precision events and a
cluster-based overlap layout that keeps every event fully visible.

## Stack

- **Backend**: Node.js + Express + embedded PGLite (PostgreSQL in-process,
  persisted to `server/pgdata/`).
- **Frontend**: Vanilla JS + Vite. The overlap layout engine lives in
  `client/src/layout.js`.

## Running

```bash
npm install        # installs root, server, and client deps (via postinstall)
npm run dev        # runs the API (:3001) and Vite dev server (:5173) together
```

Open http://localhost:5173. Vite proxies `/api/*` to the backend.

## API

- `GET /api/events?start=<iso>&end=<iso>` — events overlapping the range.
- `POST /api/events` — `{ title, start_at, end_at }`; 400 if title empty or
  `end_at <= start_at`.
- `PUT /api/events/:id` — same validation as POST.
- `DELETE /api/events/:id`.

## Layout algorithm

Events per day are grouped into maximal transitively-overlapping clusters.
Within a cluster, events are assigned columns greedily by start time; each
event's width is `1 / columnCount` of the day column and its left offset is
`columnIndex / columnCount`. Non-contended events get a full-width single
column. Vertical position/height are computed directly from minutes-from-midnight
against a single axis-height constant, so an event ending at 24:00 ends exactly
at the column's bottom edge.
