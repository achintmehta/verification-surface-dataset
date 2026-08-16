/**
 * Date utilities for the week calendar.
 * All operations work in local time.
 */

/**
 * Return the Monday of the week containing `date`.
 * @param {Date} date
 * @returns {Date}  — midnight local time on Monday
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
 * Return the Sunday (end of week) at 24:00 = next Monday 00:00.
 * @param {Date} weekStart  — Monday midnight
 * @returns {Date}          — Sunday 24:00 (= next Monday 00:00)
 */
export function getWeekEnd(weekStart) {
  const d = new Date(weekStart);
  d.setDate(d.getDate() + 7);
  return d;
}

/**
 * Return an array of 7 Date objects (Mon–Sun) for the week.
 * @param {Date} weekStart
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
 * Format a Date as "Mon 5" (abbreviated weekday + date number).
 */
export function formatDayHeader(date) {
  return {
    name: date.toLocaleDateString('en-US', { weekday: 'short' }).toUpperCase(),
    date: date.getDate(),
  };
}

/**
 * Format a Date as "HH:MM".
 */
export function formatTime(date) {
  const d = date instanceof Date ? date : new Date(date);
  return d.toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

/**
 * Format a week range as "Jan 1 – Jan 7, 2024".
 */
export function formatWeekRange(weekStart) {
  const weekEnd = new Date(weekStart);
  weekEnd.setDate(weekEnd.getDate() + 6);

  const opts = { month: 'short', day: 'numeric' };
  const startStr = weekStart.toLocaleDateString('en-US', opts);
  const endStr   = weekEnd.toLocaleDateString('en-US', { ...opts, year: 'numeric' });
  return `${startStr} – ${endStr}`;
}

/**
 * Return true if two dates are on the same calendar day (local time).
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
 */
export function isToday(date) {
  return isSameDay(date, new Date());
}

/**
 * Given a Date, return a local ISO-like string "YYYY-MM-DDTHH:MM" suitable
 * for datetime-local inputs.
 */
export function toDatetimeLocal(date) {
  const d = date instanceof Date ? date : new Date(date);
  const pad = n => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}`
  );
}

/**
 * Parse a datetime-local string "YYYY-MM-DDTHH:MM" into a Date (local time).
 */
export function fromDatetimeLocal(str) {
  // new Date(str) with no timezone suffix is treated as local time in modern browsers
  return new Date(str);
}
