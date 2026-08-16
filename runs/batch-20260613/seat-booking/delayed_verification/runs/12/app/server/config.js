// Central configuration for the seat-booking server.
export const PORT = process.env.PORT || 3001;

// Where PGLite persists its data on the local filesystem.
export const DB_DIR = process.env.DB_DIR || './server/.pgdata';

// Fixed seat map dimensions.
export const ROWS = 5;            // row labels A..E
export const SEATS_PER_ROW = 10;  // seats 1..10

// Hold time-to-live in milliseconds.
export const HOLD_TTL_MS = Number(process.env.HOLD_TTL_MS || 60_000);

// How often the background sweep releases expired holds.
export const SWEEP_INTERVAL_MS = Number(process.env.SWEEP_INTERVAL_MS || 5_000);
