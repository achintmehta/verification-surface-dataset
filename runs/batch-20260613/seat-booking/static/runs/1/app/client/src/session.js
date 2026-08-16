/**
 * Persistent session id – stored in localStorage so it survives page reloads.
 */

const KEY = 'seat_booking_session_id';

function generateId() {
  // Use crypto.randomUUID if available, otherwise fall back.
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

export function getSessionId() {
  let id = localStorage.getItem(KEY);
  if (!id) {
    id = generateId();
    localStorage.setItem(KEY, id);
  }
  return id;
}
