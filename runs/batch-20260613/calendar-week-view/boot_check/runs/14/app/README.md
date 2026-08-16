# Week Calendar

A single-user week-view calendar. Backend is Node.js + Express with embedded
PGLite (PostgreSQL in-process, persisted to local disk). Frontend is a Vanilla
JS / Vite single-page app implementing a cluster-based overlap layout.

## Layout

```
.
├── server/        Express + PGLite JSON API (entry: server/index.js)
└── client/        Vite vanilla-JS week view
```

## Install

```bash
npm run install:all
```

## Develop

Run both servers together:

```bash
npm run dev
```

- API:    http://localhost:3001
- Client: http://localhost:5173 (proxies `/api` to the API server)

Or run the API alone:

```bash
npm start
```

## API

- `GET    /api/events?start=<iso>&end=<iso>` — events overlapping the range
- `POST   /api/events` — `{ title, start_at, end_at }` (validated; 400 on bad input)
- `PUT    /api/events/:id` — update an event
- `DELETE /api/events/:id` — delete an event

Events persist to `server/data/pgdata` and survive a full restart.

## Overlap layout

Per day, events are grouped into maximal clusters of transitively overlapping
events. Within a cluster, events are greedily assigned to columns by start time;
each event's width is `1 / columns-used-by-its-cluster` and its horizontal
offset is `columnIndex * width`. Non-overlapping events therefore take the full
day-column width, while N identically-timed events render as N equal blocks side
by side. Vertical position/height are computed directly from minutes-from-
midnight, so geometry is exact to the minute and an event ending at 24:00 ends
exactly at the column's bottom edge. See `client/src/layout.js`.
