/**
 * Week navigation and date utilities.
 * Weeks run Monday–Sunday.
 */

/**
 * Get the Monday of the week containing the given date.
 * @param {Date} date
 * @returns {Date}  Midnight local time on Monday
 */
export function getWeekStart(date) {
  const d = new Date(date);
  // getDay(): 0=Sun, 1=Mon, ..., 6=Sat
  const day = d.getDay();
  // Days to subtract to reach Monday (0 for Mon, 6 for Sun)
  const diff = (day === 0) ? 6 : day - 1;
  d.setDate(d.getDate() - diff);
  d.setHours(0, 0, 0, 0);
  return d;
}

/**
 * Get the Sunday (end of week) at 24:00 = next Monday 00:00.
 * @param {Date} weekStart  Monday midnight
 * @returns {Date}  The moment just after Sunday ends (Monday 00:00)
 */
export function getWeekEnd(weekStart) {
  const d = new Date(weekStart);
  d.setDate(d.getDate() + 7);
  return d;
}

/**
 * Get an array of 7 Date objects for Mon–Sun of the given week.
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
 * Advance the week start by +/- n weeks.
 * @param {Date} weekStart
 * @param {number} n  Positive = forward, negative = backward
 * @returns {Date}
 */
export function shiftWeek(weekStart, n) {
  const d = new Date(weekStart);
  d.setDate(d.getDate() + n * 7);
  return d;
}

/**
 * Format a Date as "Mon DD" (e.g. "Mon 03").
 * @param {Date} date
 * @returns {string}
 */
export function formatDayHeader(date) {
  return date.toLocaleDateString('en-US', { weekday: 'short', day: '2-digit' });
}

/**
 * Format a week range as "Jan 1 – Jan 7, 2025".
 * @param {Date} weekStart
 * @returns {string}
 */
export function formatWeekLabel(weekStart) {
  const weekEnd = new Date(weekStart);
  weekEnd.setDate(weekEnd.getDate() + 6);

  const opts = { month: 'short', day: 'numeric' };
  const startStr = weekStart.toLocaleDateString('en-US', opts);
  const endStr = weekEnd.toLocaleDateString('en-US', { ...opts, year: 'numeric' });
  return `${startStr} – ${endStr}`;
}

/**
 * Format a Date as a datetime-local input value: "YYYY-MM-DDTHH:MM".
 * @param {Date} date
 * @returns {string}
 */
export function toDatetimeLocal(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * Parse a datetime-local string to an ISO string.
 * @param {string} value  "YYYY-MM-DDTHH:MM"
 * @returns {string}  ISO 8601
 */
export function fromDatetimeLocal(value) {
  return new Date(value).toISOString();
}

/**
 * Format a time as "HH:MM".
 * @param {string} isoString
 * @returns {string}
 */
export function formatTime(isoString) {
  const d = new Date(isoString);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * Check if two dates are on the same local calendar day.
 * @param {Date} a
 * @param {Date} b
 * @returns {boolean}
 */
export function isSameDay(a, b) {
  return a.getFullYear() === b.getFullYear() &&
         a.getMonth() === b.getMonth() &&
         a.getDate() === b.getDate();
}

/**
 * Check if a date is today.
 * @param {Date} date
 * @returns {boolean}
 */
export function isToday(date) {
  return isSameDay(date, new Date());
}
