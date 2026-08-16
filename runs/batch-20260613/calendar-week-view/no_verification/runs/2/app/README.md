# Calendar Week View

A single-user week-view calendar with minute-precision event placement, overlap layout, and PGLite persistence.

## Architecture

- **Backend**: Node.js + Express + PGLite (embedded PostgreSQL, persists to `./data/pglite/`)
- **Frontend**: Vanilla JS + Vite (no framework dependencies)

## Getting Started

```bash
# Install dependencies
npm install
cd client && npm install && cd ..

# Run both servers concurrently
npm run dev
```

- API server: http://localhost:3001
- Frontend dev server: http://localhost:5173

## API

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/events?start=<iso>&end=<iso>` | Events overlapping the range |
| POST | `/api/events` | Create event `{title, start_at, end_at}` |
| PUT | `/api/events/:id` | Update event |
| DELETE | `/api/events/:id` | Delete event |

## Layout Algorithm

Events within a day are grouped into **overlap clusters** (maximal sets of transitively overlapping events). Within each cluster, events are assigned columns greedily by start time. Each event's width = day-column-width / cluster-columns. Non-overlapping events use the full column width.

## Acceptance Criteria

- Vertical geometry is exact: top ∝ start time, height ∝ duration, to the minute.
- No two event blocks ever visually overlap.
- N identical-time events render as N equal-width side-by-side blocks.
- Partially overlapping chains render with every event fully visible.
- Non-overlapping events use full column width.
- Events are clamped to their day column; 24:00 events end at the bottom edge.
- CRUD persists across server restart and page reload.
- Invalid events (empty title, end ≤ start) are rejected with HTTP 400.
