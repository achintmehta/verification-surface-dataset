/**
 * Get the Monday of the week containing the given date.
 * @param {Date} date
 * @returns {Date}
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
 * Get the 7 days of the week starting from Monday.
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
 * Get the start of the week range (Monday 00:00:00).
 * @param {Date} monday
 * @returns {Date}
 */
export function getWeekStart(monday) {
  const d = new Date(monday);
  d.setHours(0, 0, 0, 0);
  return d;
}

/**
 * Get the end of the week range (next Monday 00:00:00).
 * @param {Date} monday
 * @returns {Date}
 */
export function getWeekEnd(monday) {
  const d = new Date(monday);
  d.setDate(d.getDate() + 7);
  d.setHours(0, 0, 0, 0);
  return d;
}

/**
 * Format date for display.
 */
export function formatDateHeader(date) {
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

/**
 * Format week range for the title.
 */
export function formatWeekTitle(monday) {
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);
  
  const opts = { month: 'long', day: 'numeric', year: 'numeric' };
  if (monday.getMonth() === sunday.getMonth()) {
    return `${monday.toLocaleDateString('en-US', { month: 'long' })} ${monday.getDate()} – ${sunday.getDate()}, ${monday.getFullYear()}`;
  }
  return `${monday.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} – ${sunday.toLocaleDateString('en-US', opts)}`;
}

/**
 * Get minutes from midnight for a Date.
 */
export function minutesFromMidnight(date) {
  return date.getHours() * 60 + date.getMinutes();
}

/**
 * Get the YYYY-MM-DD string for a Date (local).
 */
export function toDateString(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
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
 * Format time as HH:MM.
 */
export function formatTime(hours, minutes) {
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

/**
 * Format minutes from midnight as HH:MM.
 */
export function formatMinutes(mins) {
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return formatTime(h, m);
}

/**
 * Check if a date is today.
 */
export function isToday(date) {
  return isSameDay(date, new Date());
}

const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

export function dayName(dayIndex) {
  return DAY_NAMES[dayIndex];
}
