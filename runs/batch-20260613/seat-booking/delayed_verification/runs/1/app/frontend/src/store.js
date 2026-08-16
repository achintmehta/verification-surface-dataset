/**
 * store.js – Reactive application state.
 *
 * A minimal observable store: call `subscribe(listener)` to be notified
 * whenever state changes.  Mutations go through `setState`.
 */

const listeners = new Set();

/** @type {AppState} */
let state = {
  seats:          [],   // array of seat objects from the API
  selectedIds:    new Set(), // ids the user has clicked (pre-hold)
  activeHold:     null, // { id, sessionId, seatIds, expiresAt }
  booking:        null, // { holdId, sessionId, seatIds } after confirm
  loading:        false,
  notification:   null, // { type: 'info'|'success'|'error'|'warning', message }
};

export function getState() {
  return state;
}

export function setState(patch) {
  state = { ...state, ...patch };
  for (const fn of listeners) fn(state);
}

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

// ── Seat helpers ───────────────────────────────────────────────────────────

/**
 * Apply a batch of seat-status updates coming from SSE events.
 * @param {string[]} seatIds
 * @param {string}   newStatus  – 'available' | 'held' | 'booked'
 * @param {object}   [extra]    – extra fields to merge (holdExpiresAt, bookedBy…)
 */
export function applySeatUpdates(seatIds, newStatus, extra = {}) {
  const idSet = new Set(seatIds);
  const seats = state.seats.map((s) => {
    if (!idSet.has(s.id)) return s;
    return {
      ...s,
      status: newStatus,
      holdExpiresAt: newStatus === 'held'   ? (extra.expiresAt ?? null) : null,
      bookedBy:      newStatus === 'booked' ? (extra.holdId   ?? null)  : null,
    };
  });
  setState({ seats });
}
