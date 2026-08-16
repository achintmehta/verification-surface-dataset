# Week Calendar

A single-user week-view calendar. Vanilla JS / Vite frontend, Node.js + Express
backend with embedded PGLite (PostgreSQL in-process) persisting to local disk.

## Features

- 7-day week grid (Monday–Sunday) over a continuous 00:00–24:00 time axis.
- Create events by click-dragging (or clicking) an empty time range; edit and
  delete via a form.
- **Cluster-based overlap layout**: overlapping events are grouped into maximal
  transitive-overlap clusters, assigned columns greedily by start time, and each
  cluster's width is divided equally among its columns — so no two event blocks
  ever visually overlap and non-contended events use the full column width.
- Absolute, minute-precise vertical placement (top/height derived from times
  against a single hour-height constant).
- Previous / Today / Next week navigation.
- Durable persistence via PGLite; data survives server restart and page reload.

## Running

```bash
npm install
npm run dev          # runs backend (:3001) and Vite frontend (:5173) together
```

Open http://localhost:5173. The Vite dev server proxies `/api` to the backend.

Individual servers:

```bash
npm run dev:backend  # node backend/server.js  (port 3001)
npm run dev:frontend # vite                     (port 5173)
```

## API

- `GET  /api/events?start=<iso>&end=<iso>` — events overlapping `[start, end)`.
- `POST /api/events` — `{ title, start_at, end_at }`; 400 on empty title or
  `end_at <= start_at`.
- `PUT  /api/events/:id` — same validation as POST.
- `DELETE /api/events/:id`

## Data

PGLite writes to `data/pgdata/`. The `events` table enforces
`CHECK (end_at > start_at)`.

## Layout engine

`frontend/src/layout.js` is a pure function: given a day's events with
`startMin`/`endMin` (minutes from midnight), it returns each annotated with
`{ col, cols }`. Width = `1/cols`, horizontal offset = `col/cols`.
