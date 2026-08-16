/**
 * Week navigation utilities.
 * All dates are treated as local time (no timezone conversion).
 */

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                     'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * Get the Monday of the week containing `date`.
 */
export function getWeekStart(date) {
  const d = new Date(date);
  const day = d.getDay(); // 0=Sun, 1=Mon, ...
  const diff = (day === 0) ? -6 : 1 - day; // adjust to Monday
  d.setDate(d.getDate() + diff);
  d.setHours(0, 0, 0, 0);
  return d;
}

/**
 * Return an array of 7 Date objects for Mon–Sun of the week.
 */
export function getWeekDays(weekStart) {
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(weekStart);
    d.setDate(d.getDate() + i);
    return d;
  });
}

/**
 * Format a Date as "YYYY-MM-DDTHH:MM:SS" (local time, no timezone suffix).
 */
export function toLocalISO(date) {
  const pad = n => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
         `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/**
 * Format a Date as "YYYY-MM-DDTHH:MM" for datetime-local inputs.
 */
export function toInputDateTime(date) {
  const pad = n => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
         `T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * Format a week label, e.g. "Jun 2 – Jun 8, 2025"
 */
export function formatWeekLabel(weekStart) {
  const weekEnd = new Date(weekStart);
  weekEnd.setDate(weekEnd.getDate() + 6);

  const startStr = `${MONTH_NAMES[weekStart.getMonth()]} ${weekStart.getDate()}`;
  const endStr   = `${MONTH_NAMES[weekEnd.getMonth()]} ${weekEnd.getDate()}`;
  const year     = weekEnd.getFullYear();

  if (weekStart.getMonth() === weekEnd.getMonth()) {
    return `${MONTH_NAMES[weekStart.getMonth()]} ${weekStart.getDate()}–${weekEnd.getDate()}, ${year}`;
  }
  return `${startStr} – ${endStr}, ${year}`;
}

/**
 * Format a day header: { name: 'Mon', number: '2' }
 */
export function formatDayHeader(date) {
  return {
    name:   DAY_NAMES[date.getDay()],
    number: String(date.getDate()),
  };
}

/**
 * Format a time string like "09:30" from hours and minutes.
 */
export function formatTime(hours, minutes) {
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

/**
 * Format an event's time range for display, e.g. "09:00–10:30"
 * Handles midnight end (next day 00:00 → displayed as 24:00).
 */
export function formatEventTime(startISO, endISO) {
  const startDate = startISO.split('T')[0];
  const endDate   = endISO.split('T')[0];
  const startTime = startISO.split('T')[1].slice(0, 5);
  let endTime     = endISO.split('T')[1].slice(0, 5);

  // If end is next day at midnight, display as 24:00
  if (endDate !== startDate && endTime === '00:00') {
    endTime = '24:00';
  }
  return `${startTime}–${endTime}`;
}

/**
 * Get the date string (YYYY-MM-DD) from an ISO datetime.
 */
export function getDateStr(isoString) {
  return isoString.split('T')[0];
}

/**
 * Check if two dates are the same calendar day.
 */
export function isSameDay(a, b) {
  return a.getFullYear() === b.getFullYear() &&
         a.getMonth()    === b.getMonth()    &&
         a.getDate()     === b.getDate();
}

/**
 * Check if a date is today.
 */
export function isToday(date) {
  return isSameDay(date, new Date());
}

/**
 * Add weeks to a date.
 */
export function addWeeks(date, n) {
  const d = new Date(date);
  d.setDate(d.getDate() + n * 7);
  return d;
}
