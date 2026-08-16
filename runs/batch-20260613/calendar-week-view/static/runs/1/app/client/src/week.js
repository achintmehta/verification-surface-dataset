/**
 * Week navigation utilities.
 * A "week" is Monday–Sunday (ISO week convention).
 */

/**
 * Return the Monday of the week containing `date`.
 * @param {Date} date
 * @returns {Date}  midnight local time on Monday
 */
export function getWeekStart(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  // getDay(): 0=Sun, 1=Mon, …, 6=Sat
  const day = d.getDay();
  const diff = day === 0 ? -6 : 1 - day; // shift to Monday
  d.setDate(d.getDate() + diff);
  return d;
}

/**
 * Return the 7 Date objects for the week starting at `weekStart`.
 * @param {Date} weekStart  Monday midnight
 * @returns {Date[]}
 */
export function getWeekDays(weekStart) {
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(weekStart);
    d.setDate(d.getDate() + i);
    return d;
  });
}

/**
 * Advance `weekStart` by `delta` weeks.
 * @param {Date}   weekStart
 * @param {number} delta  positive = forward, negative = backward
 * @returns {Date}
 */
export function shiftWeek(weekStart, delta) {
  const d = new Date(weekStart);
  d.setDate(d.getDate() + delta * 7);
  return d;
}

/**
 * Return the exclusive end of the week (Sunday 24:00 = Monday 00:00).
 * @param {Date} weekStart
 * @returns {Date}
 */
export function getWeekEnd(weekStart) {
  const d = new Date(weekStart);
  d.setDate(d.getDate() + 7);
  return d;
}

const DAY_NAMES  = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const MONTH_NAMES = [
  'January','February','March','April','May','June',
  'July','August','September','October','November','December',
];

/**
 * Short day name for a Date (Mon–Sun).
 * @param {Date} d
 * @returns {string}
 */
export function dayName(d) {
  // getDay(): 0=Sun … 6=Sat  →  map to Mon=0 … Sun=6
  const idx = (d.getDay() + 6) % 7;
  return DAY_NAMES[idx];
}

/**
 * Human-readable week label, e.g. "Jun 30 – Jul 6, 2025".
 * @param {Date} weekStart  Monday
 * @returns {string}
 */
export function weekLabel(weekStart) {
  const weekEnd = new Date(weekStart);
  weekEnd.setDate(weekEnd.getDate() + 6); // Sunday

  const startMonth = MONTH_NAMES[weekStart.getMonth()].slice(0, 3);
  const endMonth   = MONTH_NAMES[weekEnd.getMonth()].slice(0, 3);
  const year       = weekEnd.getFullYear();

  if (weekStart.getMonth() === weekEnd.getMonth()) {
    return `${startMonth} ${weekStart.getDate()}–${weekEnd.getDate()}, ${year}`;
  }
  return `${startMonth} ${weekStart.getDate()} – ${endMonth} ${weekEnd.getDate()}, ${year}`;
}

/**
 * Format a Date as "HH:MM" in local time.
 * @param {Date} d
 * @returns {string}
 */
export function formatTime(d) {
  const h = String(d.getHours()).padStart(2, '0');
  const m = String(d.getMinutes()).padStart(2, '0');
  return `${h}:${m}`;
}

/**
 * Format a Date as "YYYY-MM-DDTHH:MM" suitable for datetime-local inputs.
 * @param {Date} d
 * @returns {string}
 */
export function toDatetimeLocal(d) {
  const y  = d.getFullYear();
  const mo = String(d.getMonth() + 1).padStart(2, '0');
  const dy = String(d.getDate()).padStart(2, '0');
  const h  = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  return `${y}-${mo}-${dy}T${h}:${mi}`;
}

/**
 * Parse a "YYYY-MM-DDTHH:MM" string as a local Date.
 * @param {string} s
 * @returns {Date}
 */
export function fromDatetimeLocal(s) {
  return new Date(s);
}
