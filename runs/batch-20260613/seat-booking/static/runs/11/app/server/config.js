// Central configuration for the seat-booking server.
export const PORT = Number(process.env.PORT) || 3001;

// Seat map dimensions.
export const ROWS = 5;
export const SEATS_PER_ROW = 10;
export const ROW_LABELS = ['A', 'B', 'C', 'D', 'E'];

// Hold time-to-live in milliseconds.
export const HOLD_TTL_MS = Number(process.env.HOLD_TTL_MS) || 60_000;

// How often the background sweep runs to release stale holds.
export const SWEEP_INTERVAL_MS = Number(process.env.SWEEP_INTERVAL_MS) || 5_000;

// Where PGLite persists its data on disk.
export const DATA_DIR = process.env.DATA_DIR || './server/.pgdata';
