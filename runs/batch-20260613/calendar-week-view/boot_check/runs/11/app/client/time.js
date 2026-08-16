// time.js — local-timezone date helpers for the week view.

export const DAY_MS = 24 * 60 * 60 * 1000;

// Returns local midnight (00:00) of the Monday on or before the given date.
export function startOfWeek(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  // getDay(): 0=Sun..6=Sat. We want Monday=start.
  const day = d.getDay();
  const diff = (day + 6) % 7; // days since Monday
  d.setDate(d.getDate() - diff);
  return d;
}

export function addDays(date, n) {
  const d = new Date(date);
  d.setDate(d.getDate() + n);
  return d;
}

export function addWeeks(date, n) {
  return addDays(date, n * 7);
}

// Minutes from local midnight of `dayStart` to the given Date.
// Used to position an event within a day column.
export function minutesFromMidnight(date, dayStart) {
  return (date.getTime() - dayStart.getTime()) / 60000;
}

// Combine a day (local midnight Date) and minutes-from-midnight into a Date.
export function dateFromMinutes(dayStart, minutes) {
  return new Date(dayStart.getTime() + minutes * 60000);
}

export function isSameDay(a, b) {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

const TWO = (n) => String(n).padStart(2, '0');

// Format a Date as HH:MM in local time.
export function formatTime(date) {
  return `${TWO(date.getHours())}:${TWO(date.getMinutes())}`;
}

// Format minutes-from-midnight (0..1440) as HH:MM.
export function formatMinutes(minutes) {
  const m = Math.round(minutes);
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return `${TWO(h)}:${TWO(mm)}`;
}

// Format a Date for an <input type="datetime-local"> (local time, no tz).
export function toDatetimeLocalValue(date) {
  return `${date.getFullYear()}-${TWO(date.getMonth() + 1)}-${TWO(
    date.getDate()
  )}T${TWO(date.getHours())}:${TWO(date.getMinutes())}`;
}

// Parse a datetime-local value (interpreted as local time) into a Date.
export function fromDatetimeLocalValue(value) {
  // new Date('YYYY-MM-DDTHH:MM') is interpreted as local time by browsers.
  return new Date(value);
}

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const MONTHS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

export function weekdayLabel(index) {
  return WEEKDAYS[index];
}

export function dayDateLabel(date) {
  return `${MONTHS[date.getMonth()]} ${date.getDate()}`;
}

export function weekRangeLabel(weekStart) {
  const end = addDays(weekStart, 6);
  const sameMonth = weekStart.getMonth() === end.getMonth();
  if (sameMonth) {
    return `${MONTHS[weekStart.getMonth()]} ${weekStart.getDate()}–${end.getDate()}, ${end.getFullYear()}`;
  }
  return `${MONTHS[weekStart.getMonth()]} ${weekStart.getDate()} – ${MONTHS[end.getMonth()]} ${end.getDate()}, ${end.getFullYear()}`;
}
