/**
 * Date utility functions for the week calendar.
 * All operations work in local time (no timezone conversion).
 */

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                     'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * Get the Monday of the week containing `date`.
 * @param {Date} date
 * @returns {Date}  midnight local time on Monday
 */
export function getWeekStart(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  // JS: 0=Sun, 1=Mon, ..., 6=Sat
  const day = d.getDay();
  // Days to subtract to reach Monday
  const diff = (day === 0) ? 6 : day - 1;
  d.setDate(d.getDate() - diff);
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
 * Format a Date as "Mon 14" style.
 * @param {Date} date
 * @returns {{ dayName: string, dayNum: number }}
 */
export function formatDayHeader(date) {
  return {
    dayName: DAY_NAMES[date.getDay()],
    dayNum: date.getDate(),
  };
}

/**
 * Format a week range label, e.g. "Jun 9 – Jun 15, 2025".
 * @param {Date} weekStart  Monday
 * @returns {string}
 */
export function formatWeekLabel(weekStart) {
  const weekEnd = new Date(weekStart);
  weekEnd.setDate(weekEnd.getDate() + 6);

  const startMonth = MONTH_NAMES[weekStart.getMonth()];
  const endMonth   = MONTH_NAMES[weekEnd.getMonth()];
  const year       = weekEnd.getFullYear();

  if (startMonth === endMonth) {
    return `${startMonth} ${weekStart.getDate()} – ${weekEnd.getDate()}, ${year}`;
  }
  return `${startMonth} ${weekStart.getDate()} – ${endMonth} ${weekEnd.getDate()}, ${year}`;
}

/**
 * Check if two dates are the same calendar day (local time).
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
 * Check if a date is today.
 * @param {Date} date
 * @returns {boolean}
 */
export function isToday(date) {
  return isSameDay(date, new Date());
}

/**
 * Format a Date as a datetime-local input value: "YYYY-MM-DDTHH:MM"
 * @param {Date} date
 * @returns {string}
 */
export function toDatetimeLocal(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
         `T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * Format a time as "HH:MM" from a Date or ISO string.
 * @param {Date|string} dateOrStr
 * @returns {string}
 */
export function formatTime(dateOrStr) {
  const d = (dateOrStr instanceof Date) ? dateOrStr : new Date(dateOrStr);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * Parse a datetime-local string ("YYYY-MM-DDTHH:MM") to an ISO string.
 * @param {string} dtLocal
 * @returns {string}  ISO string
 */
export function datetimeLocalToISO(dtLocal) {
  return new Date(dtLocal).toISOString();
}

/**
 * Given a day Date and a minutes-from-midnight value, return a Date.
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

/**
 * Return the ISO string for the start of a day (00:00:00).
 * @param {Date} day
 * @returns {string}
 */
export function dayStart(day) {
  const d = new Date(day);
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}

/**
 * Return the ISO string for the end of a day (24:00:00 = next day 00:00:00).
 * @param {Date} day
 * @returns {string}
 */
export function dayEnd(day) {
  const d = new Date(day);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + 1);
  return d.toISOString();
}
