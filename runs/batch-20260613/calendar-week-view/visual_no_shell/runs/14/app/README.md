# Week Calendar

A single-user week-view calendar. Vanilla JS + Vite frontend, Node.js + Express
backend with embedded PGLite (PostgreSQL in-process) persisting to local disk.

## Features

- 7-day week view (Monday–Sunday) with a continuous 00:00–24:00 time axis.
- Minute-precision event placement; top/height computed directly from times.
- Cluster-based overlap layout: transitively-overlapping events are grouped
  into clusters, assigned columns greedily by start time, and given equal
  widths so no two blocks ever visually overlap. Non-overlapping events use the
  full day-column width.
- Create (click or click-drag on an empty range), edit, and delete events.
- Previous / Today / Next week navigation.
- Durable persistence via PGLite; data survives server restart and page reload.

## Running

From the project root:

```bash
npm install            # installs root tooling (concurrently)
npm run install:all    # installs server + client dependencies
npm run dev            # runs backend (:3001) and frontend (:5173) together
```

Then open http://localhost:5173.

The Vite dev server proxies `/api/*` to the backend on port 3001.

## API

- `GET    /api/events?start=<iso>&end=<iso>` — events overlapping the range.
- `POST   /api/events` — create `{ title, start_at, end_at }` (400 if invalid).
- `PUT    /api/events/:id` — update.
- `DELETE /api/events/:id` — delete.

Validation: `title` must be non-empty and `end_at` must be strictly after
`start_at`; invalid input is rejected with HTTP 400 and nothing is persisted.

## Layout engine

`client/src/layout.js` contains the pure overlap-layout function `layoutDay`,
which annotates each event with its column index and the number of columns in
its cluster. It is independent of the DOM so the geometry is a pure function of
the data.
