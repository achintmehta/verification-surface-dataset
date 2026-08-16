/**
 * Date utility functions for the week calendar.
 * All dates are treated in the browser's local timezone.
 */

const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'
];

/**
 * Get the Monday of the week containing the given date.
 * Monday = start of week (ISO convention).
 */
export function getWeekStart(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  const day = d.getDay(); // 0=Sun, 1=Mon, ...
  const diff = day === 0 ? -6 : 1 - day;
  d.setDate(d.getDate() + diff);
  return d;
}

/**
 * Get the end of the week (Sunday 23:59:59.999 or effectively Monday 00:00).
 * We return the next Monday 00:00 as the exclusive end.
 */
export function getWeekEnd(weekStart) {
  const d = new Date(weekStart);
  d.setDate(d.getDate() + 7);
  return d;
}

/**
 * Get array of 7 Date objects for the days of the week, starting from weekStart (Monday).
 */
export function getWeekDays(weekStart) {
  const days = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(weekStart);
    d.setDate(d.getDate() + i);
    days.push(d);
  }
  return days;
}

/**
 * Format a Date as a nice week title, e.g. "June 2–8, 2025" or "Dec 29, 2025 – Jan 4, 2026"
 */
export function formatWeekTitle(weekStart) {
  const weekEnd = new Date(weekStart);
  weekEnd.setDate(weekEnd.getDate() + 6); // Sunday

  const startMonth = MONTH_NAMES[weekStart.getMonth()];
  const endMonth = MONTH_NAMES[weekEnd.getMonth()];

  if (weekStart.getFullYear() !== weekEnd.getFullYear()) {
    return `${startMonth.slice(0, 3)} ${weekStart.getDate()}, ${weekStart.getFullYear()} – ${endMonth.slice(0, 3)} ${weekEnd.getDate()}, ${weekEnd.getFullYear()}`;
  }
  if (weekStart.getMonth() !== weekEnd.getMonth()) {
    return `${startMonth.slice(0, 3)} ${weekStart.getDate()} – ${endMonth.slice(0, 3)} ${weekEnd.getDate()}, ${weekEnd.getFullYear()}`;
  }
  return `${startMonth} ${weekStart.getDate()}–${weekEnd.getDate()}, ${weekEnd.getFullYear()}`;
}

/**
 * Check if two dates are the same calendar day.
 */
export function isSameDay(a, b) {
  return a.getFullYear() === b.getFullYear()
    && a.getMonth() === b.getMonth()
    && a.getDate() === b.getDate();
}

/**
 * Check if a date is today.
 */
export function isToday(date) {
  return isSameDay(date, new Date());
}

export function getDayName(dayIndex) {
  return DAY_NAMES[dayIndex];
}

/**
 * Format minutes since midnight to "HH:MM" string.
 */
export function minutesToTimeStr(minutes) {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/**
 * Get minutes since midnight for a Date.
 */
export function getMinutesSinceMidnight(date) {
  return date.getHours() * 60 + date.getMinutes();
}

/**
 * Format a datetime-local input value from a Date.
 */
export function toDatetimeLocalValue(date) {
  const y = date.getFullYear();
  const mo = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  const h = String(date.getHours()).padStart(2, '0');
  const mi = String(date.getMinutes()).padStart(2, '0');
  return `${y}-${mo}-${d}T${h}:${mi}`;
}

/**
 * Format time from a Date as "HH:MM".
 */
export function formatTime(date) {
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

/**
 * Create a local ISO string (without timezone) from a Date.
 */
export function toLocalISOString(date) {
  const y = date.getFullYear();
  const mo = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  const h = String(date.getHours()).padStart(2, '0');
  const mi = String(date.getMinutes()).padStart(2, '0');
  const s = String(date.getSeconds()).padStart(2, '0');
  return `${y}-${mo}-${d}T${h}:${mi}:${s}`;
}
