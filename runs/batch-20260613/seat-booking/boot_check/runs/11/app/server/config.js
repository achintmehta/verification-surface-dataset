export const ROWS = ['A', 'B', 'C', 'D', 'E'];
export const SEATS_PER_ROW = 10;

// Hold time-to-live in milliseconds.
export const HOLD_TTL_MS = 2 * 60 * 1000; // 2 minutes

// How often the background sweep runs to release stale holds.
export const SWEEP_INTERVAL_MS = 5 * 1000; // 5 seconds

export const PORT = process.env.PORT || 3001;

// Directory on local disk where PGLite persists its data.
export const DATA_DIR = process.env.DATA_DIR || './pgdata';
