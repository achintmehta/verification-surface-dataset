/**
 * Week navigation utilities.
 * Weeks run Monday–Sunday.
 */

/**
 * Return the Monday of the week containing `date`.
 * @param {Date} date
 * @returns {Date}
 */
export function getWeekStart(date) {
  const d = new Date(date);
  // getDay(): 0=Sun, 1=Mon, …, 6=Sat
  const day = d.getDay();
  const diff = (day === 0) ? -6 : 1 - day; // shift to Monday
  d.setDate(d.getDate() + diff);
  d.setHours(0, 0, 0, 0);
  return d;
}

/**
 * Return an array of 7 Date objects (Mon–Sun) for the week starting at `monday`.
 * @param {Date} monday
 * @returns {Date[]}
 */
export function getWeekDays(monday) {
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(monday);
    d.setDate(d.getDate() + i);
    return d;
  });
}

/**
 * Add `n` weeks to a date.
 * @param {Date} date
 * @param {number} n
 * @returns {Date}
 */
export function addWeeks(date, n) {
  const d = new Date(date);
  d.setDate(d.getDate() + n * 7);
  return d;
}

/**
 * Format a Date as "YYYY-MM-DDTHH:mm" for datetime-local inputs.
 * @param {Date} date
 * @returns {string}
 */
export function toDatetimeLocal(date) {
  const pad = n => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * Format a Date as "HH:mm".
 * @param {Date} date
 * @returns {string}
 */
export function formatTime(date) {
  const pad = n => String(n).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * Format a Date as "Mon Jan 1" style.
 * @param {Date} date
 * @returns {string}
 */
export function formatDayHeader(date) {
  return date.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTH_NAMES = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

/**
 * Return { dayName, dayNum, monthName } for a Date.
 */
export function getDayParts(date) {
  return {
    dayName:   DAY_NAMES[date.getDay()],
    dayNum:    date.getDate(),
    monthName: MONTH_NAMES[date.getMonth()],
  };
}

/**
 * Format a week range label, e.g. "Jun 2 – Jun 8, 2025".
 * @param {Date} monday
 * @returns {string}
 */
export function formatWeekLabel(monday) {
  const sunday = new Date(monday);
  sunday.setDate(sunday.getDate() + 6);
  const opts = { month: 'short', day: 'numeric' };
  const start = monday.toLocaleDateString(undefined, opts);
  const end   = sunday.toLocaleDateString(undefined, { ...opts, year: 'numeric' });
  return `${start} – ${end}`;
}

/**
 * Return true if two dates are the same calendar day.
 */
export function isSameDay(a, b) {
  return a.getFullYear() === b.getFullYear()
      && a.getMonth()    === b.getMonth()
      && a.getDate()     === b.getDate();
}

/**
 * Return the ISO string for the start of a day (00:00:00).
 */
export function dayStart(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}

/**
 * Return the ISO string for the end of a day (23:59:59.999 → next day 00:00).
 */
export function dayEnd(date) {
  const d = new Date(date);
  d.setHours(24, 0, 0, 0);
  return d.toISOString();
}
