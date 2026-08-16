# Week Calendar

A single-user week-view calendar. Node.js + Express + embedded PGLite backend,
Vanilla JS / Vite frontend with a cluster-based overlap layout engine.

## Install

```bash
npm install
```

## Develop

Runs the API (port 3001) and the Vite dev server (port 5173, proxies `/api`):

```bash
npm run dev
```

Open http://localhost:5173

## Production

```bash
npm run build   # builds the SPA into dist/
npm start       # Express serves the API and the built SPA on port 3001
```

Open http://localhost:3001

## API

- `GET  /api/events?start=<iso>&end=<iso>` — events overlapping the range
- `POST /api/events` — `{ title, start_at, end_at }` (400 on empty title or end ≤ start)
- `PUT  /api/events/:id`
- `DELETE /api/events/:id`

Data persists to `./pgdata` on local disk via PGLite.

## Layout engine

`client/layout.js` groups each day's events into maximal transitively-overlapping
clusters, assigns greedy columns by start time within a cluster, and gives each
event `width = 1 / columns` with `left = columnIndex / columns`. Vertical
position/height come directly from minutes-from-midnight against a fixed axis
height, so geometry is exact to the minute and events are clamped to their day
column (an event ending at 24:00 ends exactly at the column's bottom edge).
