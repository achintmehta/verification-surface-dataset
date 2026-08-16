# Week Calendar

A single-user, week-view calendar. Vanilla JS + Vite frontend, Node.js + Express
backend with embedded PGLite (PostgreSQL) persisting to local disk.

## Features

- Week view: 7 day columns (Mon–Sun), continuous 00:00–24:00 time axis, hour grid,
  day/date headers, and a highlight on today's column.
- Minute-precise event placement: each block's top/height is computed directly from
  its start/end times against a single axis-height constant.
- **Cluster overlap layout**: overlapping events are grouped into maximal
  transitive-overlap clusters, assigned columns greedily by start time, and each
  cluster's width is divided equally among its columns. No two blocks ever overlap;
  uncontended events use the full column width.
- Create (click or click-drag a time range), edit, and delete events via a form.
- Previous / Today / Next week navigation.
- Durable persistence in PGLite; data survives server restart and page reload.

## Run

```bash
npm install
npm run dev      # starts backend (:3001) and Vite frontend (:5173) together
```

Open http://localhost:5173. The Vite dev server proxies `/api` to the backend.

Other scripts:

- `npm run dev:server` — backend only
- `npm run dev:client` — frontend only
- `npm run build` — production build of the frontend

## API

- `GET /api/events?start=<iso>&end=<iso>` — events overlapping the range
- `POST /api/events` — `{ title, start_at, end_at }`; 400 on empty title or end ≤ start
- `PUT /api/events/:id` — same validation
- `DELETE /api/events/:id`

## Layout engine

See `client/src/layout.js`. `layoutDay(events)` takes events with numeric
minutes-from-midnight `start`/`end` and returns each with `colIndex` / `colCount`,
from which width = `1/colCount` and left = `colIndex/colCount`.
