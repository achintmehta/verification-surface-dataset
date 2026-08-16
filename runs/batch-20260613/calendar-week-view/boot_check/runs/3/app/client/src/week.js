/**
 * Week navigation utilities.
 * Weeks run Monday–Sunday.
 */

/**
 * Return the Monday of the week containing `date`.
 * @param {Date} date
 * @returns {Date} — midnight local time on Monday
 */
export function getMondayOf(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  const day = d.getDay(); // 0=Sun, 1=Mon, …, 6=Sat
  const diff = (day === 0) ? -6 : 1 - day; // shift to Monday
  d.setDate(d.getDate() + diff);
  return d;
}

/**
 * Return an array of 7 Date objects (Mon–Sun) for the week starting on `monday`.
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
 * Return a new Date offset by `weeks` weeks from `monday`.
 * @param {Date} monday
 * @param {number} weeks  positive = forward, negative = backward
 * @returns {Date}
 */
export function offsetWeek(monday, weeks) {
  const d = new Date(monday);
  d.setDate(d.getDate() + weeks * 7);
  return d;
}

/**
 * Format a Date as "Mon DD MMM YYYY" for the week label.
 * @param {Date} monday
 * @param {Date} sunday
 * @returns {string}
 */
export function formatWeekLabel(monday, sunday) {
  const opts = { month: 'short', day: 'numeric' };
  const start = monday.toLocaleDateString(undefined, opts);
  const end   = sunday.toLocaleDateString(undefined, { ...opts, year: 'numeric' });
  return `${start} – ${end}`;
}

/**
 * Format a Date as "YYYY-MM-DDTHH:MM" for datetime-local inputs.
 * @param {Date} date
 * @returns {string}
 */
export function toDatetimeLocal(date) {
  const pad = n => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * Format a time as "HH:MM" from a Date or ISO string.
 * @param {Date|string} dateOrStr
 * @returns {string}
 */
export function formatTime(dateOrStr) {
  const d = (dateOrStr instanceof Date) ? dateOrStr : new Date(dateOrStr);
  const pad = n => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * Return the start (Monday 00:00) and end (Sunday+1 00:00) of the week.
 * @param {Date} monday
 * @returns {{ weekStart: Date, weekEnd: Date }}
 */
export function getWeekBounds(monday) {
  const weekStart = new Date(monday);
  weekStart.setHours(0, 0, 0, 0);
  const weekEnd = new Date(weekStart);
  weekEnd.setDate(weekEnd.getDate() + 7);
  return { weekStart, weekEnd };
}

/**
 * Given a Date, return midnight of that day.
 * @param {Date} date
 * @returns {Date}
 */
export function midnight(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

/**
 * Return minutes since midnight for a Date.
 * @param {Date} date
 * @returns {number}
 */
export function minutesFromMidnight(date) {
  return date.getHours() * 60 + date.getMinutes();
}
