# Week Calendar

A single-user week-view calendar. One week is shown as 7 day columns (Monday–Sunday)
against a continuous 00:00–24:00 time axis. Events have minute-precision start/end
times, are persisted server-side with embedded PostgreSQL (PGLite), and overlapping
events are laid out side-by-side so that **no event block ever covers another**.

## Architecture

- **`server/`** — Node.js + Express + [`@electric-sql/pglite`](https://pglite.dev).
  PGLite runs PostgreSQL inside the Node process and persists to `server/data/pgdata`
  on local disk. Exposes a small JSON API.
- **`client/`** — Vanilla JS + Vite single-page app. Implements the week grid and
  the cluster overlap layout engine (`src/layout.js`).

## Getting started

```bash
# 1. Install all dependencies (root tooling + server + client)
npm install
npm run install:all

# 2. Run backend (port 3001) and frontend (port 5173) together
npm run dev
```

Then open http://localhost:5173. The Vite dev server proxies `/api/*` to the
backend on port 3001.

To run only one side:

```bash
npm run dev:server   # Express + PGLite on :3001
npm run dev:client   # Vite on :5173
```

## API

All timestamps are ISO 8601 strings.

| Method | Path                                   | Description                                   |
| ------ | -------------------------------------- | --------------------------------------------- |
| GET    | `/api/events?start=<iso>&end=<iso>`    | Events overlapping the `[start, end)` range.  |
| POST   | `/api/events`                          | Create. Body `{ title, start_at, end_at }`.   |
| PUT    | `/api/events/:id`                      | Update.                                       |
| DELETE | `/api/events/:id`                      | Delete.                                       |

Validation: `title` must be non-empty and `end_at` must be strictly after
`start_at`; otherwise the API responds `400` and nothing is persisted. The same
constraint (`end_at > start_at`) is enforced at the database level via a `CHECK`.

## Overlap layout algorithm

Implemented in `client/src/layout.js` as pure functions:

1. **Clamp** each event to a single day (`clampToDay`). An event ending at the
   next midnight terminates exactly at the bottom edge (`MINUTES_PER_DAY`).
2. **Cluster** events of a day into maximal sets of transitively overlapping
   events.
3. Within each cluster, **greedily assign columns** by start time — an event
   reuses the first column whose previous event has already ended.
4. Each event's `widthFrac = 1 / clusterColumnCount` and
   `leftFrac = assignedColumn / clusterColumnCount`.

The renderer (`client/src/main.js`) maps minutes to pixels with a single axis
constant (`AXIS_HEIGHT`), so vertical geometry is exact to the minute, and maps
`leftFrac`/`widthFrac` to percentages of the day column width.

## Tests

The layout engine has a standalone assertion test suite covering the acceptance
criteria (equal-width identical events, partially overlapping chains, lone events
keeping full width, midnight clamping, and 200 randomized no-overlap trials):

```bash
cd client
node src/layout.test.js
```
