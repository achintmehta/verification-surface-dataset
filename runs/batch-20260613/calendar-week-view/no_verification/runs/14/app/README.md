# Week Calendar

A single-user week-view calendar. Vanilla JS + Vite frontend, Node.js + Express
backend persisting to embedded PGLite on local disk.

## Layout

```
package.json     # root: dev script runs both apps together
server/          # Express + PGLite JSON API
client/          # Vanilla JS / Vite single-page week view
```

## Setup

```bash
npm run install:all      # install root, server, and client deps
npm run dev              # start backend (:3001) and frontend (:5173) together
```

Open http://localhost:5173. The Vite dev server proxies `/api` to the backend.

For production:

```bash
npm run build            # build the client into client/dist
npm start                # start the API server
```

## API

- `GET /api/events?start=<iso>&end=<iso>` — events overlapping the range.
- `POST /api/events` — `{ title, start_at, end_at }`; 400 if title empty or
  `end_at <= start_at`.
- `PUT /api/events/:id` — same validation as POST.
- `DELETE /api/events/:id`

Events persist to `server/data/pgdata` and survive a full server restart.

## Overlap layout engine

`client/src/layout.js` implements the cluster algorithm:

1. Clip each event to a single day column in minutes-from-midnight.
2. Group transitively-overlapping segments into clusters.
3. Greedily assign columns by start time within each cluster.
4. Width = `1 / clusterColumns`; horizontal offset = `columnIndex × width`.

Vertical geometry is computed directly from time arithmetic
(`minutes × pixelsPerMinute`), so an event from 09:00–10:30 spans exactly 1.5
hour-rows, and an event ending at 24:00 terminates exactly at the column bottom.
