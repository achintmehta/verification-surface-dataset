/**
 * Generates or retrieves a persistent session id stored in localStorage.
 */

const KEY = 'seat_booking_session_id';

export function getSessionId() {
  let id = localStorage.getItem(KEY);
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem(KEY, id);
  }
  return id;
}
