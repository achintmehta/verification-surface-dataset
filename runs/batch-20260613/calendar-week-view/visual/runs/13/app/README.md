# Week Calendar

A single-user week-view calendar. Node.js + Express + embedded PGLite backend,
Vanilla JS / Vite frontend with a cluster-based overlap layout engine.

## Run

```bash
npm install
npm run dev
```

- Frontend (Vite dev server): http://localhost:5173
- Backend (Express API): http://localhost:3001 (proxied under `/api` by Vite)

Events persist to `data/pgdata` on local disk via PGLite, so they survive a
full server restart and page reload.

### Production-style serving

```bash
npm run build   # builds the frontend into dist/
npm start       # Express serves the API and the built frontend on :3001
```

## API

| Method | Path                                   | Notes                                            |
|--------|----------------------------------------|--------------------------------------------------|
| GET    | `/api/events?start=<iso>&end=<iso>`    | Events overlapping `[start, end)`.               |
| POST   | `/api/events`                          | `{title, start_at, end_at}`. 400 if invalid.     |
| PUT    | `/api/events/:id`                      | Update. 400 if invalid, 404 if missing.          |
| DELETE | `/api/events/:id`                      | Delete. 204 on success, 404 if missing.          |

Validation: `title` must be non-empty and `end_at` must be after `start_at`
(enforced both in the API and by a `CHECK` constraint on the `events` table).

## Layout engine (`src/layout.js`)

Per day, events are grouped into maximal transitively-overlapping clusters.
Within a cluster, events are assigned columns greedily by start time; the width
of every event in a cluster is the day-column width divided by the number of
columns the cluster needed. Vertical position/height are computed directly from
minutes-from-midnight against a single axis-height constant, so geometry is
exact to the minute. Events are clamped to their day column; an event ending at
24:00 ends exactly at the column's bottom edge.

## Optional seed data

With the dev server running, `node server/seed.js` inserts demo events into the
current week that exercise the layout (identical overlaps, partial chains,
non-overlapping full-width events, a 24:00 event).
