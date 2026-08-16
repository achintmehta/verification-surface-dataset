/**
 * Persistent session ID stored in localStorage.
 * A new random ID is generated on first visit.
 */

const KEY = 'seat-booking-session-id';

export function getSessionId() {
  let id = localStorage.getItem(KEY);
  if (!id) {
    id = `sess-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    localStorage.setItem(KEY, id);
  }
  return id;
}
