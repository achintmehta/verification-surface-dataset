# Week Calendar

A single-user, week-view calendar. Seven day columns (Mon–Sun) share a
continuous 00:00–24:00 time axis. Events are created, edited, and deleted with
minute precision, persisted server-side in embedded PostgreSQL (PGLite), and
laid out with a cluster-based overlap algorithm so that overlapping events
always render side-by-side and fully visible.

## Architecture

- **Backend** (`backend/`): Node.js + Express + `@electric-sql/pglite`.
  PGLite runs Postgres inside the Node process and persists to
  `backend/data/pgdata` on the local filesystem. Exposes a JSON API.
- **Frontend** (`frontend/`): Vanilla JS + Vite single-page week view. The
  overlap layout engine lives in `frontend/src/layout.js` as pure functions.

## Layout engine (the core challenge)

`layout.js` implements the standard calendar overlap algorithm:

1. Events for a day are sorted by start time.
2. They are grouped into **clusters** — maximal sets of transitively
   overlapping events.
3. Within a cluster, each event is greedily assigned the lowest free column
   (a column is free if its last event has already ended).
4. Every event's width is `1 / clusterColumnCount` and its horizontal offset
   is `columnIndex / clusterColumnCount`.

Vertical geometry is computed directly from minutes-from-midnight against a
single axis height, so an event from 09:00–10:30 spans exactly 1.5 hour rows
and an event ending at 24:00 ends exactly at the column's bottom edge.

## Running

Install all dependencies (root, backend, frontend):

```bash
npm install
npm run install:all
```

Run the backend and frontend dev servers together:

```bash
npm run dev
```

- Backend: http://localhost:3001
- Frontend: http://localhost:5173 (Vite proxies `/api` to the backend)

You can also run them separately:

```bash
npm run dev:backend
npm run dev:frontend
```

## API

- `GET /api/events?start=<iso>&end=<iso>` — events overlapping `[start, end)`.
- `POST /api/events` — body `{ title, start_at, end_at }`. Validates a
  non-empty title and `end_at > start_at`; rejects invalid input with `400`.
- `PUT /api/events/:id` — update an event (same validation).
- `DELETE /api/events/:id` — delete an event.

Timestamps are ISO 8601 strings; the browser's local time zone is used for
display.
