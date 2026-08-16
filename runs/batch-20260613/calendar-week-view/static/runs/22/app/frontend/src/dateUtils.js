/**
 * Date utility functions for week calendar.
 */

const DAY_NAMES_SHORT = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

/**
 * Get Monday of the week containing the given date.
 * @param {Date} date
 * @returns {Date} Monday at 00:00:00.000 local time
 */
export function getMonday(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  const day = d.getDay(); // 0 = Sunday, 1 = Monday, ..., 6 = Saturday
  const diff = day === 0 ? -6 : 1 - day;
  d.setDate(d.getDate() + diff);
  return d;
}

/**
 * Get an array of 7 Dates for Mon–Sun of the week starting at monday.
 * @param {Date} monday
 * @returns {Date[]}
 */
export function getWeekDays(monday) {
  const days = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(monday);
    d.setDate(monday.getDate() + i);
    days.push(d);
  }
  return days;
}

/**
 * Get the start of the next week.
 */
export function nextWeek(monday) {
  const d = new Date(monday);
  d.setDate(d.getDate() + 7);
  return d;
}

/**
 * Get the start of the previous week.
 */
export function prevWeek(monday) {
  const d = new Date(monday);
  d.setDate(d.getDate() - 7);
  return d;
}

/**
 * Check if two dates are the same calendar day (local time).
 */
export function isSameDay(a, b) {
  return a.getFullYear() === b.getFullYear()
    && a.getMonth() === b.getMonth()
    && a.getDate() === b.getDate();
}

/**
 * Format a week title like "January 6 – 12, 2025" or "December 29, 2025 – January 4, 2026"
 */
export function formatWeekTitle(monday) {
  const days = getWeekDays(monday);
  const sun = days[6];
  if (monday.getFullYear() !== sun.getFullYear()) {
    return `${MONTH_NAMES[monday.getMonth()]} ${monday.getDate()}, ${monday.getFullYear()} – ${MONTH_NAMES[sun.getMonth()]} ${sun.getDate()}, ${sun.getFullYear()}`;
  }
  if (monday.getMonth() !== sun.getMonth()) {
    return `${MONTH_NAMES[monday.getMonth()]} ${monday.getDate()} – ${MONTH_NAMES[sun.getMonth()]} ${sun.getDate()}, ${monday.getFullYear()}`;
  }
  return `${MONTH_NAMES[monday.getMonth()]} ${monday.getDate()} – ${sun.getDate()}, ${monday.getFullYear()}`;
}

/**
 * Get short day name (Mon, Tue, etc) for index 0-6.
 */
export function dayName(index) {
  return DAY_NAMES_SHORT[index];
}

/**
 * Format time as HH:MM (24h).
 */
export function formatTime(hours, minutes) {
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

/**
 * Format a Date's time as HH:MM.
 */
export function formatDateTime(date) {
  return formatTime(date.getHours(), date.getMinutes());
}

/**
 * Format date as YYYY-MM-DD for <input type="date">.
 */
export function formatDateInput(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * Format minutes-from-midnight as HH:MM.
 */
export function minutesToTimeStr(totalMinutes) {
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  return formatTime(h, m);
}

/**
 * Parse HH:MM into minutes from midnight.
 */
export function timeStrToMinutes(str) {
  const [h, m] = str.split(':').map(Number);
  return h * 60 + m;
}

/**
 * Build an ISO datetime string from a date string (YYYY-MM-DD) and time string (HH:MM).
 * Returns a Date in local time.
 */
export function buildLocalDate(dateStr, timeStr) {
  const [year, month, day] = dateStr.split('-').map(Number);
  const [hours, minutes] = timeStr.split(':').map(Number);
  return new Date(year, month - 1, day, hours, minutes, 0, 0);
}
