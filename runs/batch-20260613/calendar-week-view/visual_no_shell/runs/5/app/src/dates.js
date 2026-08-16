/**
 * Date utilities for the week calendar.
 *
 * IMPORTANT: All timestamps are treated as wall-clock (local) time throughout.
 * We never call .toISOString() (which converts to UTC).  Instead we use
 * toLocalISOString() which formats using local time components.
 */

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'
];

const pad = (n) => String(n).padStart(2, '0');

/**
 * Format a Date as a wall-clock ISO string "YYYY-MM-DDTHH:MM:SS"
 * using LOCAL time components (no UTC conversion, no trailing Z).
 */
export function toLocalISOString(date) {
  const d = date instanceof Date ? date : new Date(date);
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  );
}

/**
 * Parse a wall-clock string "YYYY-MM-DDTHH:MM:SS" (no Z, no offset)
 * as a local Date.  new Date("YYYY-MM-DDTHH:MM:SS") is treated as local
 * time in all modern JS engines.
 */
export function parseLocalISO(str) {
  // Ensure no trailing Z or offset
  const clean = String(str).replace(/Z$/, '').replace(/[+-]\d{2}:\d{2}$/, '');
  return new Date(clean);
}

/**
 * Get the Monday of the week containing the given date.
 */
export function getWeekStart(date) {
  const d = new Date(date);
  const day = d.getDay(); // 0=Sun, 1=Mon, ...
  const diff = (day === 0) ? -6 : 1 - day;
  d.setDate(d.getDate() + diff);
  d.setHours(0, 0, 0, 0);
  return d;
}

/**
 * Get an array of 7 Date objects for Mon–Sun of the week.
 */
export function getWeekDays(weekStart) {
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(weekStart);
    d.setDate(d.getDate() + i);
    return d;
  });
}

/**
 * Format a date as { name: "Mon", number: 15 }
 */
export function formatDayHeader(date) {
  return {
    name: DAY_NAMES[date.getDay()],
    number: date.getDate(),
  };
}

/**
 * Format a week range label: "Jun 15–21, 2026"
 */
export function formatWeekLabel(weekStart) {
  const weekEnd = new Date(weekStart);
  weekEnd.setDate(weekEnd.getDate() + 6);

  const startMonth = MONTH_NAMES[weekStart.getMonth()];
  const endMonth = MONTH_NAMES[weekEnd.getMonth()];
  const year = weekEnd.getFullYear();

  if (weekStart.getMonth() === weekEnd.getMonth()) {
    return `${startMonth} ${weekStart.getDate()}–${weekEnd.getDate()}, ${year}`;
  } else if (weekStart.getFullYear() === weekEnd.getFullYear()) {
    return `${startMonth} ${weekStart.getDate()} – ${endMonth} ${weekEnd.getDate()}, ${year}`;
  } else {
    return `${startMonth} ${weekStart.getDate()}, ${weekStart.getFullYear()} – ${endMonth} ${weekEnd.getDate()}, ${year}`;
  }
}

/**
 * Check if two dates are the same calendar day (local time).
 */
export function isSameDay(a, b) {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

/**
 * Format a Date to a datetime-local input value: "YYYY-MM-DDTHH:MM"
 * Uses local time components.
 */
export function toDatetimeLocal(date) {
  const d = date instanceof Date ? date : parseLocalISO(date);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * Format a time as "HH:MM" from a wall-clock string or Date.
 */
export function formatTime(wallClockOrDate) {
  const d = wallClockOrDate instanceof Date
    ? wallClockOrDate
    : parseLocalISO(wallClockOrDate);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * Snap minutes to the nearest N-minute interval.
 */
export function snapMinutes(minutes, snap = 15) {
  return Math.round(minutes / snap) * snap;
}

/**
 * Convert pixel offset within a day column to minutes from midnight.
 */
export function pxToMinutes(px, hourHeight = 60) {
  return Math.max(0, Math.min(1440, (px / hourHeight) * 60));
}

/**
 * Build a Date from a day date and minutes-from-midnight (local time).
 */
export function minutesToDate(dayDate, minutes) {
  const d = new Date(dayDate);
  d.setHours(0, 0, 0, 0);
  d.setMinutes(minutes);
  return d;
}
