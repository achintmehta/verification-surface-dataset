# Week Calendar

A single-user week-view calendar with minute-precise event placement and a
cluster-based overlap layout engine.

- **Backend**: Node.js + Express + embedded [PGLite](https://github.com/electric-sql/pglite)
  persisting to `./pgdata` on the local filesystem.
- **Frontend**: Vanilla JS + Vite single-page week view.

## Getting started

```bash
npm install
npm run dev
```

`npm run dev` runs both servers together:

- Express API on <http://localhost:3001>
- Vite dev server on <http://localhost:5173> (proxies `/api` to the backend)

Open <http://localhost:5173>.

### Individual servers

```bash
npm run dev:server   # Express + PGLite API only
npm run dev:client   # Vite frontend only
```

### Production build

```bash
npm run build        # build the frontend into ./dist
npm start            # Express serves the API and (if present) ./dist
```

## API

- `GET /api/events?start=<iso>&end=<iso>` — events overlapping the range.
- `POST /api/events` — `{ title, start_at, end_at }`; 400 if title empty or
  `end_at <= start_at`.
- `PUT /api/events/:id` — update an event (same validation).
- `DELETE /api/events/:id` — delete an event.

## Layout engine

`client/layout.js` is a pure function over numeric `[start, end)` minute
intervals. Within each day, transitively overlapping events form a *cluster*;
columns are assigned greedily by start time and each cluster's width is divided
equally among the columns it required. Non-overlapping events occupy the full
day-column width. See `client/main.js` for the pixel geometry derived from a
single axis-height constant.
