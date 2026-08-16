/**
 * Date utility functions for the calendar.
 * All dates are in the browser's local time zone.
 */

/**
 * Get the Monday of the week containing the given date.
 * @param {Date} date
 * @returns {Date} Monday at 00:00:00.000 local time
 */
export function getMonday(date) {
  const d = new Date(date);
  const day = d.getDay(); // 0=Sun,1=Mon,...,6=Sat
  const diff = day === 0 ? -6 : 1 - day;
  d.setDate(d.getDate() + diff);
  d.setHours(0, 0, 0, 0);
  return d;
}

/**
 * Get the Sunday (end) of the week, i.e. the following Monday at 00:00:00.
 * This defines the exclusive end of the week range.
 * @param {Date} monday
 * @returns {Date}
 */
export function getWeekEnd(monday) {
  const d = new Date(monday);
  d.setDate(d.getDate() + 7);
  return d;
}

/**
 * Get an array of 7 Date objects representing Monday–Sunday of the week.
 * @param {Date} monday
 * @returns {Date[]}
 */
export function getWeekDays(monday) {
  const days = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(monday);
    d.setDate(d.getDate() + i);
    days.push(d);
  }
  return days;
}

/**
 * Format a date as "Mon, Jan 1" etc.
 * @param {Date} date
 * @returns {{ dayName: string, dayDate: string }}
 */
export function formatDayHeader(date) {
  const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
    'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return {
    dayName: dayNames[date.getDay()],
    dayDate: `${monthNames[date.getMonth()]} ${date.getDate()}`
  };
}

/**
 * Format week title, e.g. "Jan 6 – Jan 12, 2025"
 * @param {Date} monday
 * @returns {string}
 */
export function formatWeekTitle(monday) {
  const sunday = new Date(monday);
  sunday.setDate(sunday.getDate() + 6);
  const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
    'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  const mStart = monthNames[monday.getMonth()];
  const mEnd = monthNames[sunday.getMonth()];

  if (monday.getFullYear() !== sunday.getFullYear()) {
    return `${mStart} ${monday.getDate()}, ${monday.getFullYear()} – ${mEnd} ${sunday.getDate()}, ${sunday.getFullYear()}`;
  }
  if (monday.getMonth() !== sunday.getMonth()) {
    return `${mStart} ${monday.getDate()} – ${mEnd} ${sunday.getDate()}, ${sunday.getFullYear()}`;
  }
  return `${mStart} ${monday.getDate()} – ${sunday.getDate()}, ${sunday.getFullYear()}`;
}

/**
 * Check if two dates are the same calendar day.
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
 * Get minutes from midnight for a date in local time.
 * @param {Date} date
 * @returns {number}
 */
export function minutesFromMidnight(date) {
  return date.getHours() * 60 + date.getMinutes();
}

/**
 * Format time as HH:MM.
 * @param {number} hours
 * @param {number} minutes
 * @returns {string}
 */
export function formatTime(hours, minutes) {
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

/**
 * Format a Date's time portion as HH:MM.
 * @param {Date} date
 * @returns {string}
 */
export function formatDateTime(date) {
  return formatTime(date.getHours(), date.getMinutes());
}

/**
 * Convert a local Date to a datetime-local input value string.
 * @param {Date} date
 * @returns {string} e.g. "2025-01-06T09:00"
 */
export function toDatetimeLocalValue(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  const h = String(date.getHours()).padStart(2, '0');
  const min = String(date.getMinutes()).padStart(2, '0');
  return `${y}-${m}-${d}T${h}:${min}`;
}
