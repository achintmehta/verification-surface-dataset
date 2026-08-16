/**
 * Week navigation utilities.
 * Weeks run Monday–Sunday.
 */

/**
 * Return the Monday of the week containing `date`.
 * @param {Date} date
 * @returns {Date} Monday 00:00:00 local time
 */
export function getMondayOf(date) {
  const d = new Date(date);
  // getDay(): 0=Sun,1=Mon,...,6=Sat
  const day = d.getDay();
  const diff = (day === 0) ? -6 : 1 - day; // shift to Monday
  d.setDate(d.getDate() + diff);
  d.setHours(0, 0, 0, 0);
  return d;
}

/**
 * Return an array of 7 Date objects (Mon–Sun) for the week starting at monday.
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
 * Format a Date as "Mon 12" (abbreviated day name + date number).
 * @param {Date} date
 * @returns {{ dayName: string, dayNum: string }}
 */
export function formatDayHeader(date) {
  const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  return {
    dayName: dayNames[date.getDay()],
    dayNum:  String(date.getDate()),
  };
}

/**
 * Format a week range as "Jun 2 – 8, 2025" or "Dec 29, 2024 – Jan 4, 2025".
 * @param {Date} monday
 * @param {Date} sunday
 * @returns {string}
 */
export function formatWeekLabel(monday, sunday) {
  const opts = { month: 'short', day: 'numeric' };
  const mStr = monday.toLocaleDateString(undefined, opts);
  const sStr = sunday.toLocaleDateString(undefined, opts);
  const year = sunday.getFullYear();
  if (monday.getFullYear() !== sunday.getFullYear()) {
    return `${monday.toLocaleDateString(undefined, { ...opts, year: 'numeric' })} – ${sunday.toLocaleDateString(undefined, { ...opts, year: 'numeric' })}`;
  }
  return `${mStr} – ${sStr}, ${year}`;
}

/**
 * Return true if two Date objects represent the same calendar day (local time).
 * @param {Date} a
 * @param {Date} b
 * @returns {boolean}
 */
export function isSameDay(a, b) {
  return a.getFullYear() === b.getFullYear() &&
         a.getMonth()    === b.getMonth()    &&
         a.getDate()     === b.getDate();
}

/**
 * Given a Date, return the number of minutes since midnight (local time).
 * @param {Date} date
 * @returns {number}
 */
export function minutesFromMidnight(date) {
  return date.getHours() * 60 + date.getMinutes();
}
