/**
 * session.js – Persistent session id stored in localStorage.
 *
 * A session id is a simple UUID that identifies this browser tab's "user".
 * It is created once and reused across page reloads.
 */

const KEY = 'seat-booking-session-id';

function generateId() {
  // Use crypto.randomUUID if available (modern browsers), otherwise fallback.
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  // Simple fallback
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

export function getSessionId() {
  let id = localStorage.getItem(KEY);
  if (!id) {
    id = generateId();
    localStorage.setItem(KEY, id);
  }
  return id;
}
