/**
 * Date utilities for the week calendar.
 * All operations work in local time.
 */

const DAY_NAMES  = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTH_NAMES = [
  'January','February','March','April','May','June',
  'July','August','September','October','November','December'
];

/**
 * Return the Monday of the week containing `date`.
 * @param {Date} date
 * @returns {Date} midnight local time on Monday
 */
export function getWeekStart(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  // getDay(): 0=Sun, 1=Mon, ..., 6=Sat
  const day = d.getDay();
  // distance to Monday: if Sunday (0) go back 6 days, else go back (day-1)
  const diff = day === 0 ? -6 : 1 - day;
  d.setDate(d.getDate() + diff);
  return d;
}

/**
 * Return an array of 7 Date objects (Mon–Sun) for the week starting at `weekStart`.
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
 * Add `n` weeks to a date.
 * @param {Date} date
 * @param {number} n  may be negative
 * @returns {Date}
 */
export function addWeeks(date, n) {
  const d = new Date(date);
  d.setDate(d.getDate() + n * 7);
  return d;
}

/**
 * Format a Date as "Mon DD" (e.g. "Mon 03").
 * @param {Date} date
 * @returns {string}
 */
export function formatDayHeader(date) {
  return DAY_NAMES[date.getDay()];
}

/**
 * Format a Date as the numeric day of month.
 * @param {Date} date
 * @returns {string}
 */
export function formatDayNum(date) {
  return String(date.getDate());
}

/**
 * Format a week range label, e.g. "June 2 – 8, 2025".
 * @param {Date} weekStart  Monday
 * @returns {string}
 */
export function formatWeekLabel(weekStart) {
  const days = getWeekDays(weekStart);
  const mon = days[0];
  const sun = days[6];
  if (mon.getMonth() === sun.getMonth()) {
    return `${MONTH_NAMES[mon.getMonth()]} ${mon.getDate()} – ${sun.getDate()}, ${sun.getFullYear()}`;
  }
  if (mon.getFullYear() === sun.getFullYear()) {
    return `${MONTH_NAMES[mon.getMonth()]} ${mon.getDate()} – ${MONTH_NAMES[sun.getMonth()]} ${sun.getDate()}, ${sun.getFullYear()}`;
  }
  return `${MONTH_NAMES[mon.getMonth()]} ${mon.getDate()}, ${mon.getFullYear()} – ${MONTH_NAMES[sun.getMonth()]} ${sun.getDate()}, ${sun.getFullYear()}`;
}

/**
 * Return true if two dates fall on the same calendar day (local time).
 * @param {Date} a
 * @param {Date} b
 * @returns {boolean}
 */
export function isSameDay(a, b) {
  return a.getFullYear() === b.getFullYear()
      && a.getMonth()    === b.getMonth()
      && a.getDate()     === b.getDate();
}

/**
 * Return the ISO string for the start of a day (midnight local → UTC ISO).
 * @param {Date} day
 * @returns {string}
 */
export function dayStart(day) {
  const d = new Date(day);
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}

/**
 * Return the ISO string for the end of a day (23:59:59.999 local → UTC ISO).
 * @param {Date} day
 * @returns {string}
 */
export function dayEnd(day) {
  const d = new Date(day);
  d.setHours(23, 59, 59, 999);
  return d.toISOString();
}

/**
 * Format a Date as a datetime-local input value: "YYYY-MM-DDTHH:MM"
 * @param {Date} date
 * @returns {string}
 */
export function toDatetimeLocal(date) {
  const pad = n => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth()+1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * Parse a datetime-local string "YYYY-MM-DDTHH:MM" to a local Date.
 * @param {string} str
 * @returns {Date}
 */
export function fromDatetimeLocal(str) {
  // new Date('YYYY-MM-DDTHH:MM') is parsed as local time in modern browsers
  return new Date(str);
}

/**
 * Format a time as "HH:MM" from a Date.
 * @param {Date|string} time
 * @returns {string}
 */
export function formatTime(time) {
  const d = time instanceof Date ? time : new Date(time);
  const pad = n => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
