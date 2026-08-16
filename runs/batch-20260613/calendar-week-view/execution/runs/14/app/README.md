# Week Calendar

A single-user week-view calendar. Node.js + Express + embedded PGLite backend,
Vanilla JS + Vite frontend implementing a cluster-based overlap layout.

## Structure

- `backend/` — Express API persisting events to PGLite on local disk.
- `frontend/` — Vite single-page week view + the pure layout engine.

## Install

```bash
npm run install:all
```

## Run (dev)

Runs the API (port 3001) and the Vite dev server (port 5173) together. The Vite
dev server proxies `/api` to the backend.

```bash
npm run dev
```

Then open http://localhost:5173.

## API

- `GET  /api/events?start=<iso>&end=<iso>` — events overlapping the range.
- `POST /api/events` — `{ title, start_at, end_at }`. 400 on invalid input.
- `PUT  /api/events/:id` — update.
- `DELETE /api/events/:id` — delete.

## Tests

The overlap layout engine is unit-tested:

```bash
npm test
```

## Layout algorithm

Events are vertically positioned by minutes-from-midnight against a fixed axis
height. Within each day, events are grouped into maximal clusters of
transitively overlapping events; within a cluster, events are assigned to the
first free column greedily by start time, and each event's width is
`1 / columnsUsed`. Non-overlapping events therefore fill the full column width,
and overlapping events share the width with zero visual overlap.
