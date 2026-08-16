/**
 * Date utility functions for calendar navigation.
 * All operations use local time.
 */

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 
                     'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * Get the Monday of the week containing the given date.
 * @param {Date} date
 * @returns {Date} Monday at 00:00:00
 */
export function getMonday(date) {
  const d = new Date(date);
  const day = d.getDay(); // 0=Sun, 1=Mon, ...
  const diff = day === 0 ? -6 : 1 - day; // if Sunday, go back 6 days
  d.setDate(d.getDate() + diff);
  d.setHours(0, 0, 0, 0);
  return d;
}

/**
 * Get an array of 7 dates (Mon–Sun) for the week starting at monday.
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
 * Get the start of the week (Monday 00:00) and the end (next Monday 00:00)
 * for use as the query range.
 */
export function getWeekRange(monday) {
  const start = new Date(monday);
  start.setHours(0, 0, 0, 0);
  const end = new Date(monday);
  end.setDate(end.getDate() + 7);
  end.setHours(0, 0, 0, 0);
  return { start, end };
}

/**
 * Format a date for display: "Mon 12"
 */
export function formatDayHeader(date) {
  return {
    dayName: DAY_NAMES[date.getDay()],
    dayNumber: date.getDate()
  };
}

/**
 * Format week title: "Jan 6 – 12, 2025" or "Dec 30, 2024 – Jan 5, 2025"
 */
export function formatWeekTitle(monday) {
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);

  const mMonth = MONTH_NAMES[monday.getMonth()];
  const sMonth = MONTH_NAMES[sunday.getMonth()];

  if (monday.getFullYear() !== sunday.getFullYear()) {
    return `${mMonth} ${monday.getDate()}, ${monday.getFullYear()} – ${sMonth} ${sunday.getDate()}, ${sunday.getFullYear()}`;
  }
  if (monday.getMonth() !== sunday.getMonth()) {
    return `${mMonth} ${monday.getDate()} – ${sMonth} ${sunday.getDate()}, ${sunday.getFullYear()}`;
  }
  return `${mMonth} ${monday.getDate()} – ${sunday.getDate()}, ${sunday.getFullYear()}`;
}

/**
 * Check if two dates are the same calendar day.
 */
export function isSameDay(a, b) {
  return a.getFullYear() === b.getFullYear() &&
         a.getMonth() === b.getMonth() &&
         a.getDate() === b.getDate();
}

/**
 * Format time as HH:MM
 */
export function formatTime(hours, minutes) {
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

/**
 * Convert a Date to minutes from midnight in local time.
 */
export function minutesFromMidnight(date) {
  return date.getHours() * 60 + date.getMinutes();
}

/**
 * Format as local ISO string for datetime-local input: "YYYY-MM-DDTHH:MM"
 */
export function toLocalISOString(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  const h = String(date.getHours()).padStart(2, '0');
  const min = String(date.getMinutes()).padStart(2, '0');
  return `${y}-${m}-${d}T${h}:${min}`;
}

/**
 * Format as full ISO-like string for API: "YYYY-MM-DDTHH:MM:SS"
 */
export function toAPIDateString(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  const h = String(date.getHours()).padStart(2, '0');
  const min = String(date.getMinutes()).padStart(2, '0');
  const s = String(date.getSeconds()).padStart(2, '0');
  return `${y}-${m}-${d}T${h}:${min}:${s}`;
}
