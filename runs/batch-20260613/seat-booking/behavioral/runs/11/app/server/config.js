// Shared configuration for the seat-booking service.

export const ROWS = ['A', 'B', 'C', 'D', 'E'];
export const SEATS_PER_ROW = 10;

// Time-to-live for a hold, in milliseconds.
export const HOLD_TTL_MS = 2 * 60 * 1000; // 2 minutes

// How often the background sweep runs, in milliseconds.
export const SWEEP_INTERVAL_MS = 5 * 1000; // 5 seconds

export const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;

// Where PGLite persists its data on disk.
export const DATA_DIR = process.env.DATA_DIR || './pgdata';
