# Week Calendar

A single-user week-view calendar. Node.js + Express + embedded PGLite backend,
Vanilla JS / Vite frontend implementing a cluster-based overlap layout engine.

## Features

- 7-column week view (Mon–Sun) over a continuous 00:00–24:00 time axis.
- Minute-precise event placement: top/height derived from start/end times.
- Cluster overlap layout: transitively overlapping events are grouped, assigned
  columns greedily by start time, and share the day-column width equally so no
  block ever covers another. Non-overlapping events use the full column width.
- Create events by click or click-drag on an empty range; edit / delete via a form.
- Previous / Today / Next week navigation.
- Durable persistence to local disk via PGLite (`data/pgdata`).

## Getting started

```bash
npm install
npm run dev      # runs backend (3001) and Vite frontend (5173) together
```

Open http://localhost:5173. The frontend proxies `/api/*` to the backend.

### Production-style serving

```bash
npm run build    # outputs dist/
npm start        # Express serves the API and the built frontend on :3001
```

## API

| Method | Path | Description |
| --- | --- | --- |
| GET | `/api/events?start=<iso>&end=<iso>` | Events overlapping the range |
| POST | `/api/events` | Create (title non-empty, `end_at > start_at`, else 400) |
| PUT | `/api/events/:id` | Update an event |
| DELETE | `/api/events/:id` | Delete an event |

Events: `{ id, title, start_at (ISO), end_at (ISO) }`.

## Layout engine

`client/layout.js` is a pure function of the data and is unit-tested:

```bash
node test/layout.test.mjs
```
