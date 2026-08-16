// Central configuration for the seat-booking service.

export const PORT = process.env.PORT ? Number(process.env.PORT) : 3001;

// Where PGLite persists its data on the local file system.
export const DATA_DIR = process.env.PGLITE_DIR || './server/.pgdata';

// Fixed seat map dimensions.
export const ROWS = 5; // labelled A..E
export const SEATS_PER_ROW = 10; // numbered 1..10

// Hold time-to-live in milliseconds.
export const HOLD_TTL_MS = process.env.HOLD_TTL_MS
  ? Number(process.env.HOLD_TTL_MS)
  : 60_000;

// How often the background sweep releases expired holds.
export const SWEEP_INTERVAL_MS = 5_000;
