# Week Calendar

A single-user week-view calendar. Backend: Node.js + Express + embedded PGLite
(persists to local disk). Frontend: Vanilla JS + Vite implementing a
cluster-based overlap layout engine.

## Structure

- `backend/` — Express JSON API and PGLite database (`backend/data/pgdata`).
- `frontend/` — Vite single-page app. Layout engine in `frontend/src/layout.js`.

## Running

From the repository root:

```bash
npm run install:all   # install root + backend + frontend deps
npm run dev           # runs backend (port 3001) and frontend (port 5173) together
```

Open http://localhost:5173. The Vite dev server proxies `/api/*` to the backend.

## API

- `GET /api/events?start=<iso>&end=<iso>` — events overlapping the range.
- `POST /api/events` — `{ title, start_at, end_at }`. 400 if title empty or
  `end_at <= start_at`.
- `PUT /api/events/:id` — same validation as POST.
- `DELETE /api/events/:id`.

## Layout engine

`layoutDay(events)` groups events into maximal transitive-overlap clusters,
greedily assigns columns by start time within each cluster, and reports
`{ colIndex, colCount }` per event. The renderer maps these to fractional
left/width, and maps start/end minutes to absolute top/height against a single
day-height constant (`HOUR_HEIGHT * 24`), so geometry is exact to the minute and
an event ending at 24:00 ends exactly at the column's bottom edge.

## Seeding demo data

Visit http://localhost:5173?seed=1 once to insert a set of fixtures
demonstrating identical-time stacking, partial-overlap chains, full-width solo
events, and an event ending at 24:00.
