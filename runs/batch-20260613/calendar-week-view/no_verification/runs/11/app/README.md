# Week Calendar

A single-user week-view calendar. 7 day columns against a continuous
00:00–24:00 time axis, with minute-precision event placement and a
cluster-based overlap layout that keeps every event fully visible.

- **Backend:** Node.js + Express + embedded PGLite (persists to local disk).
- **Frontend:** Vanilla JS + Vite.

## Getting started

Install dependencies for both packages:

```bash
npm run install:all
```

Run the backend and frontend dev servers together:

```bash
npm run dev
```

- Frontend: http://localhost:5173 (Vite, proxies `/api` to the backend)
- Backend API: http://localhost:3001

Or run them separately:

```bash
npm run dev:server
npm run dev:client
```

## API

| Method | Path                                  | Description                                |
| ------ | ------------------------------------- | ------------------------------------------ |
| GET    | `/api/events?start=<iso>&end=<iso>`   | Events overlapping the range               |
| POST   | `/api/events`                         | Create (title, start_at, end_at)           |
| PUT    | `/api/events/:id`                     | Update an event                            |
| DELETE | `/api/events/:id`                     | Delete an event                            |

Validation: `title` must be non-empty and `end_at` must be strictly after
`start_at`; invalid input is rejected with HTTP 400. The database also enforces
`end_at > start_at` via a CHECK constraint.

## Data persistence

PGLite writes to `server/data/pgdata`. Data survives server restarts and page
reloads. Delete that directory to reset.

## Layout engine

`client/src/layout.js` is a pure module:

- **Vertical:** an event's `top`/`height` are computed from minutes-from-midnight
  mapped onto a single axis-height constant, clamped to `[0, 1440]` so an event
  ending at 24:00 ends exactly at the column's bottom edge.
- **Horizontal:** events are grouped into maximal clusters of transitively
  overlapping events; within each cluster columns are assigned greedily by start
  time, and the cluster's width is divided equally among the columns it needed.
  Non-overlapping events take the full day-column width.
