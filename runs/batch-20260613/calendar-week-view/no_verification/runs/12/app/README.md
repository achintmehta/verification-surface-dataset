# Week Calendar

A single-user week-view calendar. Node.js + Express + embedded PGLite backend,
Vanilla JS / Vite frontend. The centerpiece is a cluster-based overlap layout
engine that guarantees no two event blocks ever visually overlap while using the
full day-column width whenever events are uncontended.

## Structure

```
backend/     Express + PGLite JSON API
frontend/    Vite single-page week view + layout engine
```

## Install

```bash
npm install            # root (concurrently)
npm run install:all    # installs backend + frontend deps
```

## Run (development)

```bash
npm run dev            # runs backend (:3001) and frontend (:5173) together
```

Then open http://localhost:5173. The Vite dev server proxies `/api` to the
backend.

Run individually:

```bash
npm run dev:backend
npm run dev:frontend
```

## Data persistence

PGLite writes to `backend/data/pgdata` on the local filesystem, so events
survive a full server restart.

## API

- `GET /api/events?start=<iso>&end=<iso>` — events overlapping `[start, end)`
- `POST /api/events` — `{ title, start_at, end_at }`; 400 on empty title or
  `end_at <= start_at`
- `PUT /api/events/:id` — update; same validation
- `DELETE /api/events/:id` — delete

## Layout engine

`frontend/src/layout.js`:

- Vertical geometry comes directly from time arithmetic against a single
  axis-height constant (minute precision; 24:00 lands exactly on the bottom).
- Events per day are grouped into maximal transitively-overlapping clusters.
- Columns are assigned greedily by start time within each cluster.
- An event's width = (columns it can span) / (columns the cluster needed),
  so uncontended events reclaim full width even inside a wide day.
