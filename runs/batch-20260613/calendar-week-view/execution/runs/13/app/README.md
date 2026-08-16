# Week Calendar

A single-user, week-view calendar. 7 day columns (Mon–Sun) on a continuous
00:00–24:00 time axis, with minute-precise event placement and a cluster-based
overlap layout that keeps every event fully visible.

## Stack

- **Backend**: Node.js + Express + embedded [PGLite](https://github.com/electric-sql/pglite) (PostgreSQL in-process, persisted to local disk).
- **Frontend**: Vanilla JS + Vite single-page app. The overlap layout engine lives in `client/src/layout.js`.

## Running

Install dependencies:

```bash
npm install
```

Run backend and frontend dev servers together:

```bash
npm run dev
```

- Frontend (Vite): http://localhost:5173 — open this in the browser.
- Backend API: http://localhost:3001 (the Vite dev server proxies `/api` here).

Individually:

```bash
npm run dev:backend    # Express + PGLite on :3001
npm run dev:frontend   # Vite on :5173
```

Production build + serve from the backend:

```bash
npm run build          # outputs dist/
npm start              # Express serves dist/ and the API on :3001
```

Data is persisted under `data/pgdata` (override with the `PGLITE_DIR` env var).

## API

| Method | Path                                   | Description                                          |
|--------|----------------------------------------|------------------------------------------------------|
| GET    | `/api/events?start=<iso>&end=<iso>`    | Events overlapping `[start, end)`.                   |
| POST   | `/api/events`                          | Create. Body `{title, start_at, end_at}`. 400 if invalid. |
| PUT    | `/api/events/:id`                      | Update. Same body/validation as POST.                |
| DELETE | `/api/events/:id`                      | Delete. 204 on success.                              |

Validation: `title` must be non-empty; `end_at` must be strictly after
`start_at`. The DB also enforces `CHECK (end_at > start_at)`.

## Layout engine

Events in a day are grouped into maximal clusters of transitively overlapping
events. Within a cluster, events are assigned columns greedily by start time;
each event's width is `span / columnCount` of the day-column width (where
`span` lets a non-contended event expand into free columns to its right) and
its horizontal offset is `columnIndex / columnCount`. Vertical top/height come
directly from minutes-from-midnight mapped onto a single axis-height constant,
so geometry is exact to the minute and an event ending at 24:00 lands on the
column's bottom edge.

## Interaction

- Click-drag (or single click) on empty space opens a create form pre-filled
  with the selected time range.
- Click an event to edit or delete it.
- Prev / Today / Next navigate weeks and refetch.
