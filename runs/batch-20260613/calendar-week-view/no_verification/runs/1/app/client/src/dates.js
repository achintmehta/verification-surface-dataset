/**
 * Date utilities for the week calendar.
 * All operations work in local time.
 */

/**
 * Return the Monday of the week containing `date`.
 * @param {Date} date
 * @returns {Date}
 */
export function getWeekStart(date) {
  const d = new Date(date);
  // getDay(): 0=Sun, 1=Mon, ..., 6=Sat
  const day = d.getDay();
  // Offset to Monday: if Sunday (0) → -6, else → -(day-1)
  const offset = day === 0 ? -6 : 1 - day;
  d.setDate(d.getDate() + offset);
  d.setHours(0, 0, 0, 0);
  return d;
}

/**
 * Return an array of 7 Date objects (Mon–Sun) for the week starting at `weekStart`.
 * @param {Date} weekStart  Must be a Monday at 00:00:00.
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
 * Add `n` weeks to a date, returning a new Date.
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
 * Format a Date as "YYYY-MM-DDTHH:MM:SS" (local time, no timezone suffix).
 * @param {Date} date
 * @returns {string}
 */
export function toLocalIso(date) {
  const pad = n => String(n).padStart(2, '0');
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  );
}

/**
 * Format a Date as "YYYY-MM-DDTHH:MM" for datetime-local inputs.
 * @param {Date} date
 * @returns {string}
 */
export function toInputDatetime(date) {
  const pad = n => String(n).padStart(2, '0');
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}`
  );
}

/**
 * Format a Date as a short time string "HH:MM".
 * @param {Date} date
 * @returns {string}
 */
export function formatTime(date) {
  const pad = n => String(n).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * Format a Date as "Mon 12" (day name + date number).
 * @param {Date} date
 * @returns {{ dayName: string, dayNum: number }}
 */
export function formatDayHeader(date) {
  const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  return {
    dayName: dayNames[date.getDay()],
    dayNum:  date.getDate(),
  };
}

/**
 * Format a week range label: "Jun 2 – Jun 8, 2025"
 * @param {Date} weekStart
 * @returns {string}
 */
export function formatWeekLabel(weekStart) {
  const weekEnd = new Date(weekStart);
  weekEnd.setDate(weekEnd.getDate() + 6);

  const monthNames = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const sm = monthNames[weekStart.getMonth()];
  const em = monthNames[weekEnd.getMonth()];
  const sy = weekStart.getFullYear();
  const ey = weekEnd.getFullYear();

  if (sy === ey) {
    if (sm === em) {
      return `${sm} ${weekStart.getDate()} – ${weekEnd.getDate()}, ${sy}`;
    }
    return `${sm} ${weekStart.getDate()} – ${em} ${weekEnd.getDate()}, ${sy}`;
  }
  return `${sm} ${weekStart.getDate()}, ${sy} – ${em} ${weekEnd.getDate()}, ${ey}`;
}

/**
 * Return true if two Date objects represent the same calendar day (local time).
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
 * Return the number of minutes since midnight for a Date.
 * @param {Date} date
 * @returns {number}
 */
export function minutesFromMidnight(date) {
  return date.getHours() * 60 + date.getMinutes();
}

/**
 * Snap minutes to the nearest `snap` interval.
 * @param {number} minutes
 * @param {number} snap  e.g. 15
 * @returns {number}
 */
export function snapMinutes(minutes, snap = 15) {
  return Math.round(minutes / snap) * snap;
}
