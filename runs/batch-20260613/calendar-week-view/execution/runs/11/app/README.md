# Week Calendar

A single-user, week-view calendar. Node.js + Express + embedded PGLite backend,
Vanilla JS + Vite frontend. The defining feature is a precise, cluster-based
overlap layout: any number of overlapping events render side by side, fully
visible, with vertical geometry exact to the minute.

## Running

```bash
npm install
npm run dev        # runs backend (:3001) and Vite frontend (:5173) together
```

Open http://localhost:5173. The Vite dev server proxies `/api` to the backend.

For a production-style run:

```bash
npm run build      # builds the frontend to ./dist
npm start          # serves the API on :3001
```

## Architecture

- **Backend** (`backend/`)
  - `db.js` — initializes embedded PGLite, persisting to `./data/pgdata`, and
    creates the `events` table (`id`, `title`, `start_at`, `end_at`) with a
    `CHECK (end_at > start_at)` constraint.
  - `server.js` — Express app (CORS + JSON) exposing:
    - `GET /api/events?start=<iso>&end=<iso>` — events overlapping the range.
    - `POST /api/events` — validates non-empty title and `end_at > start_at`
      (400 on invalid).
    - `PUT /api/events/:id`, `DELETE /api/events/:id`.

- **Frontend** (`frontend/`)
  - `layout.js` — the pure overlap-layout engine (clustering, greedy column
    assignment, fractional left/width). No DOM dependencies.
  - `time.js` — local-time-zone date helpers.
  - `api.js` — JSON fetch wrapper.
  - `main.js` — week grid rendering, absolute time-to-pixel positioning,
    drag-to-create, edit/delete modal, week navigation.

## Layout algorithm

1. Per day, each event is clamped to `[00:00, 24:00)` and expressed in minutes.
2. Events are grouped into **clusters** of transitively overlapping events.
3. Within a cluster, events are assigned greedily (by start time) to the lowest
   free column; the cluster width is divided equally among the columns used.
4. Top/height come directly from minutes-from-midnight, so a 09:00–10:30 event
   spans exactly 1.5 hour-rows and a 24:00 end sits flush with the bottom edge.

A non-overlapping event forms its own single-column cluster and therefore uses
the full day-column width, even when other clusters exist earlier in the day.
