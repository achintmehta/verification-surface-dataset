// Central configuration for the seat-booking service.

export const ROWS = ['A', 'B', 'C', 'D', 'E'];
export const SEATS_PER_ROW = 10;

// Time-to-live for a hold, in milliseconds.
export const HOLD_TTL_MS = Number(process.env.HOLD_TTL_MS || 2 * 60 * 1000);

// How often the lazy sweep runs to release stale holds, in milliseconds.
export const SWEEP_INTERVAL_MS = Number(process.env.SWEEP_INTERVAL_MS || 5 * 1000);

// HTTP port for the backend.
export const PORT = Number(process.env.PORT || 3001);

// Directory where PGLite persists its data.
export const DATA_DIR = process.env.DATA_DIR || './pgdata';
