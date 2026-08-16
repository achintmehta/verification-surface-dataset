/**
 * store.js – Reactive in-memory state for the seat map.
 *
 * Keeps a Map<seatId, seat> and notifies subscribers on every change.
 * This is intentionally minimal – no framework needed.
 */

export function createStore() {
  /** @type {Map<string, object>} */
  const seats = new Map();
  const listeners = new Set();

  function notify() {
    for (const fn of listeners) fn(seats);
  }

  return {
    /** Replace the entire seat map. */
    setSeats(seatArray) {
      seats.clear();
      for (const s of seatArray) seats.set(s.id, s);
      notify();
    },

    /** Patch one or more seats by id. */
    patchSeats(updates) {
      for (const u of updates) {
        const existing = seats.get(u.id);
        if (existing) {
          seats.set(u.id, { ...existing, ...u });
        } else {
          seats.set(u.id, u);
        }
      }
      notify();
    },

    /** Return a sorted array of all seats. */
    getSeats() {
      return [...seats.values()].sort((a, b) => {
        if (a.rowLabel !== b.rowLabel) return a.rowLabel < b.rowLabel ? -1 : 1;
        return a.seatNumber - b.seatNumber;
      });
    },

    getSeat(id) {
      return seats.get(id);
    },

    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}
