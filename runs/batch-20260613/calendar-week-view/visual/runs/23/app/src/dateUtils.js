/**
 * Get the Monday of the week containing the given date.
 */
export function getMonday(date) {
  const d = new Date(date);
  const day = d.getDay(); // 0=Sun, 1=Mon, ..., 6=Sat
  const diff = day === 0 ? -6 : 1 - day; // if Sunday, go back 6 days
  d.setDate(d.getDate() + diff);
  d.setHours(0, 0, 0, 0);
  return d;
}

/**
 * Get the Sunday end (midnight of next Monday) for a week starting on Monday.
 */
export function getSundayEnd(monday) {
  const d = new Date(monday);
  d.setDate(d.getDate() + 7);
  d.setHours(0, 0, 0, 0);
  return d;
}

/**
 * Get array of 7 Date objects (Mon-Sun) for the week starting at monday.
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
 * Format a date range as a title string, e.g. "Jan 6 – 12, 2025" or "Dec 30, 2024 – Jan 5, 2025"
 */
export function formatWeekTitle(monday) {
  const sunday = new Date(monday);
  sunday.setDate(sunday.getDate() + 6);

  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  if (monday.getFullYear() === sunday.getFullYear() && monday.getMonth() === sunday.getMonth()) {
    return `${months[monday.getMonth()]} ${monday.getDate()} – ${sunday.getDate()}, ${monday.getFullYear()}`;
  } else if (monday.getFullYear() === sunday.getFullYear()) {
    return `${months[monday.getMonth()]} ${monday.getDate()} – ${months[sunday.getMonth()]} ${sunday.getDate()}, ${monday.getFullYear()}`;
  } else {
    return `${months[monday.getMonth()]} ${monday.getDate()}, ${monday.getFullYear()} – ${months[sunday.getMonth()]} ${sunday.getDate()}, ${sunday.getFullYear()}`;
  }
}

/**
 * Format time as HH:MM
 */
export function formatTime(date) {
  const h = date.getHours().toString().padStart(2, '0');
  const m = date.getMinutes().toString().padStart(2, '0');
  return `${h}:${m}`;
}

/**
 * Format date for datetime-local input value
 */
export function toDatetimeLocal(date) {
  const d = new Date(date);
  const year = d.getFullYear();
  const month = (d.getMonth() + 1).toString().padStart(2, '0');
  const day = d.getDate().toString().padStart(2, '0');
  const hours = d.getHours().toString().padStart(2, '0');
  const minutes = d.getMinutes().toString().padStart(2, '0');
  return `${year}-${month}-${day}T${hours}:${minutes}`;
}

/**
 * Check if two dates are the same calendar day
 */
export function isSameDay(d1, d2) {
  return d1.getFullYear() === d2.getFullYear() &&
         d1.getMonth() === d2.getMonth() &&
         d1.getDate() === d2.getDate();
}

/**
 * Check if a date is today
 */
export function isToday(date) {
  return isSameDay(date, new Date());
}

/**
 * Day names for headers
 */
export const DAY_NAMES = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'];
