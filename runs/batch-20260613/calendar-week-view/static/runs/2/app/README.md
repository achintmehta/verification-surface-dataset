# Calendar Week View

A single-user week-view calendar with minute-precision event placement and correct overlap layout.

## Architecture

- **Backend**: Node.js + Express + PGLite (embedded PostgreSQL, persists to `./data/pglite/`)
- **Frontend**: Vanilla JS + Vite (served on port 5173, proxies `/api` to port 3001)

## Getting Started

```bash
# Install all dependencies (root + workspaces)
npm install

# Run both servers concurrently (backend :3001, frontend :5173)
npm run dev
```

Then open http://localhost:5173 in your browser.

## Features

- **Week grid**: 7 day columns (Mon–Sun), continuous 00:00–24:00 time axis, today highlighted
- **Minute-precision placement**: event top/height computed directly from start/end times
- **Overlap layout**: cluster-based algorithm — overlapping events share horizontal space side-by-side; non-overlapping events use full column width
- **Create**: click or drag on any time slot to open the create form pre-filled with that range
- **Edit / Delete**: click any event block to open the edit form
- **Navigation**: Previous / Today / Next week buttons
- **Persistence**: events survive server restarts and page reloads (PGLite on disk)

## API

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/events?start=<iso>&end=<iso>` | Events overlapping the range |
| POST | `/api/events` | Create event `{title, start_at, end_at}` |
| PUT | `/api/events/:id` | Update event |
| DELETE | `/api/events/:id` | Delete event |

## Overlap Layout Algorithm

Events within a day are grouped into **clusters** — maximal sets of transitively overlapping events. Within each cluster:

1. Events are sorted by start time.
2. Column indices are assigned greedily: each event takes the first column whose last occupant has already ended.
3. All events in the cluster share the same `colCount` (number of columns opened), so each gets width = `100% / colCount`.

Events in different clusters are independent and each use the full column width.
