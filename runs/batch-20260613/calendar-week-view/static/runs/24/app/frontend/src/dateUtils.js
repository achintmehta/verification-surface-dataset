/**
 * Date utility functions for the week calendar.
 * All operations use the browser's local timezone.
 */

/** Day names starting Monday */
export const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/**
 * Get the Monday of the week containing the given date.
 * Uses ISO week convention (Monday = first day of week).
 */
export function getMonday(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  const day = d.getDay(); // 0=Sun, 1=Mon, ...
  const diff = day === 0 ? -6 : 1 - day;
  d.setDate(d.getDate() + diff);
  return d;
}

/**
 * Returns an array of 7 Date objects for Mon–Sun of the week containing `referenceDate`.
 */
export function getWeekDays(referenceDate) {
  const monday = getMonday(referenceDate);
  const days = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(monday);
    d.setDate(monday.getDate() + i);
    days.push(d);
  }
  return days;
}

/**
 * Returns the start of the week (Monday 00:00:00.000) as a Date.
 */
export function weekStart(referenceDate) {
  return getMonday(referenceDate);
}

/**
 * Returns the end of the week (following Monday 00:00:00.000) as a Date.
 */
export function weekEnd(referenceDate) {
  const monday = getMonday(referenceDate);
  const end = new Date(monday);
  end.setDate(monday.getDate() + 7);
  return end;
}

/**
 * Check if two dates represent the same calendar day (in local tz).
 */
export function isSameDay(a, b) {
  return a.getFullYear() === b.getFullYear()
    && a.getMonth() === b.getMonth()
    && a.getDate() === b.getDate();
}

/**
 * Format a Date as YYYY-MM-DD.
 */
export function formatDate(d) {
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Format a Date as HH:MM.
 */
export function formatTime(d) {
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/**
 * Get minutes from midnight for a Date in local timezone.
 */
export function minutesFromMidnight(d) {
  return d.getHours() * 60 + d.getMinutes();
}

/**
 * Format a date for the datetime-local input value.
 * Returns "YYYY-MM-DDTHH:MM"
 */
export function toDatetimeLocalValue(d) {
  return `${formatDate(d)}T${formatTime(d)}`;
}

/**
 * Format week title, e.g. "Jan 6 – Jan 12, 2025"
 */
export function formatWeekTitle(weekDays) {
  const first = weekDays[0];
  const last = weekDays[6];
  const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
    'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  const firstStr = `${monthNames[first.getMonth()]} ${first.getDate()}`;
  const lastStr = `${monthNames[last.getMonth()]} ${last.getDate()}`;

  if (first.getFullYear() === last.getFullYear()) {
    return `${firstStr} – ${lastStr}, ${first.getFullYear()}`;
  }
  return `${firstStr}, ${first.getFullYear()} – ${lastStr}, ${last.getFullYear()}`;
}
