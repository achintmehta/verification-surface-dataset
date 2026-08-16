# Week Calendar

A single-user, week-view calendar built as a traditional client-server web app.

- **Backend:** Node.js + Express + embedded [PGLite](https://github.com/electric-sql/pglite) persisting to local disk.
- **Frontend:** Vanilla JS + Vite, with a cluster-based overlap layout engine.

## Features

- 7 day columns (Monday–Sunday) on a continuous 00:00–24:00 time axis.
- Minute-precise event placement (top/height proportional to start/end times).
- Cluster overlap layout: transitively overlapping events are grouped, assigned
  columns greedily, and share the day-column width equally; non-contended
  events use the full width.
- Create (click or drag a time range), edit, and delete events.
- Previous / Today / Next week navigation.
- Durable persistence via PGLite (survives server restart).

## Install

```bash
# install root (server) deps and frontend deps
npm install
cd client && npm install && cd ..
```

(Or, if available: `npm run install:all`.)

## Run

### Single process (server also serves the frontend)

```bash
npm start
# open http://localhost:3001
```

### Development (separate Vite dev server with API proxy)

```bash
npm run dev
# frontend: http://localhost:5173  (proxies /api to :3001)
# backend:  http://localhost:3001
```

## API

- `GET /api/events?start=<iso>&end=<iso>` — events overlapping the range.
- `POST /api/events` — `{ title, start_at, end_at }`; 400 on empty title or
  `end_at <= start_at`.
- `PUT /api/events/:id` — same validation.
- `DELETE /api/events/:id`.

## Layout engine

See `client/src/layout.js`. Pure functions:

- `clampToDayMinutes(...)` clamps an event to a single day's minute axis.
- `layoutDay(items)` returns each item with fractional `{ left, width }` of the
  day column, guaranteeing zero visual overlap.
