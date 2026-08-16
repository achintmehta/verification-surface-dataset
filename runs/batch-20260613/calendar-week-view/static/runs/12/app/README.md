# Week Calendar

A single-user week-view calendar with minute-precise overlap layout.

- **Backend**: Node.js + Express + embedded [PGLite](https://github.com/electric-sql/pglite),
  persisting to `./pgdata` on local disk.
- **Frontend**: Vanilla JS + Vite, with a cluster-based overlap layout engine.

## Running

Install dependencies, then run both servers together:

```bash
npm install
npm run dev
```

- The API server listens on `http://localhost:3001`.
- The Vite dev server serves the UI on `http://localhost:5173` and proxies
  `/api` to the backend.

Run individually:

```bash
npm run dev:server   # API only
npm run dev:client   # UI only
```

## API

| Method | Path                               | Description                              |
| ------ | ---------------------------------- | ---------------------------------------- |
| GET    | `/api/events?start=<iso>&end=<iso>`| Events overlapping `[start, end)`        |
| POST   | `/api/events`                      | Create (title, start_at, end_at)         |
| PUT    | `/api/events/:id`                  | Update                                   |
| DELETE | `/api/events/:id`                  | Delete                                   |

Invalid input (empty title, `end_at <= start_at`) is rejected with `400` and
nothing is persisted.

## Layout engine

`client/src/layout.js` is a pure module:

- Events are clamped to each day (`00:00`–`24:00`); an event ending at `24:00`
  ends exactly at the column's bottom edge.
- Per day, events are grouped into maximal transitively-overlapping clusters.
- Within a cluster, columns are assigned greedily by start time; each event's
  width is `1 / colCount` and its left offset is `colIndex / colCount`.
- Non-overlapping events (and events after an earlier cluster ends) use the full
  column width.

Top/height come directly from minutes-from-midnight, so geometry is exact to the
minute.
