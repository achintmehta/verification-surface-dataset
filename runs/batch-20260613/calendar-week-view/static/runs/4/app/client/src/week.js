/**
 * week.js – Utilities for working with ISO weeks (Monday–Sunday).
 */

const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

/**
 * Return the Monday of the week that contains `date` (local time).
 * @param {Date} date
 * @returns {Date}  Midnight local time on Monday.
 */
export function getWeekStart(date) {
  const d = new Date(date);
  // getDay(): 0=Sun, 1=Mon, …, 6=Sat
  const day = d.getDay();
  // Offset to Monday: if Sunday (0) → -6, else → -(day-1)
  const offset = day === 0 ? -6 : 1 - day;
  d.setDate(d.getDate() + offset);
  d.setHours(0, 0, 0, 0);
  return d;
}

/**
 * Return an array of 7 Date objects (Mon–Sun) for the week starting at
 * `weekStart`.
 * @param {Date} weekStart  Monday midnight.
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
 * Advance `weekStart` by `delta` weeks (positive = forward, negative = back).
 * @param {Date} weekStart
 * @param {number} delta
 * @returns {Date}
 */
export function shiftWeek(weekStart, delta) {
  const d = new Date(weekStart);
  d.setDate(d.getDate() + delta * 7);
  return d;
}

/**
 * Return the start (Monday 00:00) and end (Sunday 24:00 = next Monday 00:00)
 * of the week as ISO strings suitable for the API.
 * @param {Date} weekStart
 * @returns {{ start: Date, end: Date }}
 */
export function getWeekRange(weekStart) {
  const start = new Date(weekStart);
  const end = new Date(weekStart);
  end.setDate(end.getDate() + 7);
  return { start, end };
}

/**
 * Format a week label like "Jun 30 – Jul 6, 2025".
 * @param {Date} weekStart
 * @returns {string}
 */
export function formatWeekLabel(weekStart) {
  const days = getWeekDays(weekStart);
  const first = days[0];
  const last  = days[6];

  const firstStr = `${MONTH_NAMES[first.getMonth()].slice(0, 3)} ${first.getDate()}`;
  const lastStr  = `${MONTH_NAMES[last.getMonth()].slice(0, 3)} ${last.getDate()}`;
  const year = last.getFullYear();

  return `${firstStr} – ${lastStr}, ${year}`;
}

/**
 * Return the short day name for a Date (Mon, Tue, …).
 * @param {Date} date
 * @returns {string}
 */
export function getDayName(date) {
  // getDay(): 0=Sun → index 6, 1=Mon → index 0, …
  const idx = date.getDay() === 0 ? 6 : date.getDay() - 1;
  return DAY_NAMES[idx];
}

/**
 * Return true if two Dates fall on the same calendar day (local time).
 * @param {Date} a
 * @param {Date} b
 * @returns {boolean}
 */
export function isSameDay(a, b) {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth()    === b.getMonth()    &&
    a.getDate()     === b.getDate()
  );
}

/**
 * Return true if `date` is today.
 * @param {Date} date
 * @returns {boolean}
 */
export function isToday(date) {
  return isSameDay(date, new Date());
}

/**
 * Given a pixel Y offset within the grid and the total grid height, return
 * the number of minutes from midnight (clamped to [0, 1440]).
 * @param {number} y
 * @param {number} totalHeight
 * @returns {number}
 */
export function yToMinutes(y, totalHeight) {
  const raw = (y / totalHeight) * 1440;
  return Math.max(0, Math.min(1440, raw));
}

/**
 * Round minutes to the nearest `step` minutes.
 * @param {number} minutes
 * @param {number} [step=15]
 * @returns {number}
 */
export function snapMinutes(minutes, step = 15) {
  return Math.round(minutes / step) * step;
}

/**
 * Combine a Date (for the calendar day) with a minutes-from-midnight value
 * to produce a full Date object.
 * @param {Date} day
 * @param {number} minutes
 * @returns {Date}
 */
export function dayPlusMinutes(day, minutes) {
  const d = new Date(day);
  d.setHours(0, 0, 0, 0);
  d.setMinutes(minutes);
  return d;
}
