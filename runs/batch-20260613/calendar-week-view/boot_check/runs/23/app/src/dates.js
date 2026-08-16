/**
 * Date utility functions.
 * All dates are in browser-local time zone.
 */

/** Get Monday of the week containing the given date (ISO week: Monday-based) */
export function getMonday(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  const day = d.getDay(); // 0 = Sunday
  const diff = day === 0 ? -6 : 1 - day;
  d.setDate(d.getDate() + diff);
  return d;
}

/** Get 7 days starting from a Monday */
export function getWeekDays(monday) {
  const days = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(monday);
    d.setDate(d.getDate() + i);
    days.push(d);
  }
  return days;
}

/** Format date as "Mon 12" etc. */
export function formatDayHeader(date) {
  const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  return `${dayNames[date.getDay()]} ${date.getDate()}`;
}

/** Format week range: "Jan 6 – Jan 12, 2025" */
export function formatWeekTitle(monday) {
  const sunday = new Date(monday);
  sunday.setDate(sunday.getDate() + 6);

  const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
    'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  const m1 = monthNames[monday.getMonth()];
  const m2 = monthNames[sunday.getMonth()];
  const y1 = monday.getFullYear();
  const y2 = sunday.getFullYear();

  if (y1 !== y2) {
    return `${m1} ${monday.getDate()}, ${y1} – ${m2} ${sunday.getDate()}, ${y2}`;
  }
  if (monday.getMonth() !== sunday.getMonth()) {
    return `${m1} ${monday.getDate()} – ${m2} ${sunday.getDate()}, ${y1}`;
  }
  return `${m1} ${monday.getDate()} – ${sunday.getDate()}, ${y1}`;
}

/** Check if two dates are on the same calendar day */
export function isSameDay(a, b) {
  return a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate();
}

/** Get minutes from midnight for a date, clamped to [0, 1440] */
export function minutesFromMidnight(date) {
  return date.getHours() * 60 + date.getMinutes();
}

/** Format minutes as "HH:MM" */
export function formatTime(totalMinutes) {
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/** Create a date from a day-date and minutes from midnight */
export function dateFromMinutes(dayDate, minutes) {
  const d = new Date(dayDate);
  d.setHours(Math.floor(minutes / 60), minutes % 60, 0, 0);
  return d;
}

/** Format a Date to YYYY-MM-DDTHH:mm for datetime-local inputs */
export function toLocalInputValue(date) {
  const y = date.getFullYear();
  const mo = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  const h = String(date.getHours()).padStart(2, '0');
  const mi = String(date.getMinutes()).padStart(2, '0');
  return `${y}-${mo}-${d}T${h}:${mi}`;
}
