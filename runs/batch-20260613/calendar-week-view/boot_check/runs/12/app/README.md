# Week Calendar

A single-user week-view calendar. Node.js + Express + embedded PGLite backend,
Vanilla JS + Vite frontend implementing a cluster-based overlap layout.

## Install & run

```bash
npm install        # installs root + backend + frontend deps
npm run dev        # runs backend (:3001) and frontend (:5173) together
```

Open http://localhost:5173. The Vite dev server proxies `/api` to the backend.

## API

- `GET /api/events?start=<iso>&end=<iso>` — events overlapping the range
- `POST /api/events` — `{ title, start_at, end_at }`
- `PUT /api/events/:id`
- `DELETE /api/events/:id`

Validation: title must be non-empty and `end_at > start_at`, else HTTP 400.
Data persists to `backend/data/pgdata` via PGLite.

## Layout engine

`frontend/src/layout.js` groups each day's events into transitive overlap
clusters, greedily assigns columns by start time, and splits each cluster's
width equally among the columns it needed. Geometry (top/height) is computed
directly from minutes-from-midnight against a single axis-height constant.
