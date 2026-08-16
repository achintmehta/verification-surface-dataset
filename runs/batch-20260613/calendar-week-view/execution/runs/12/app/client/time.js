// Date / time helpers operating in the browser's local time zone.

export const MINUTES_PER_DAY = 24 * 60;

// Return Date at local midnight for the Monday of the week containing `date`.
export function startOfWeek(date) {
  const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const day = d.getDay(); // 0 = Sun, 1 = Mon, ...
  const diff = (day + 6) % 7; // days since Monday
  d.setDate(d.getDate() - diff);
  d.setHours(0, 0, 0, 0);
  return d;
}

export function addDays(date, n) {
  const d = new Date(date);
  d.setDate(d.getDate() + n);
  return d;
}

export function startOfDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), 0, 0, 0, 0);
}

export function sameDay(a, b) {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

// Minutes from local midnight of `dayStart` to `date`. Can be negative or > 1440.
export function minutesFromDayStart(dayStart, date) {
  return (date.getTime() - dayStart.getTime()) / 60000;
}

export function pad2(n) {
  return String(n).padStart(2, '0');
}

// Format minutes-from-midnight as HH:MM (handles 1440 -> 24:00).
export function formatMinutes(mins) {
  const m = Math.round(mins);
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return `${pad2(h)}:${pad2(mm)}`;
}

export function formatTimeRange(startDate, endDate) {
  return `${pad2(startDate.getHours())}:${pad2(startDate.getMinutes())}–${pad2(
    endDate.getHours()
  )}:${pad2(endDate.getMinutes())}`;
}

// Build a Date from a day (Date at midnight) plus minutes-from-midnight.
export function dateFromDayMinutes(dayStart, minutes) {
  const d = new Date(dayStart);
  d.setMinutes(d.getMinutes() + Math.round(minutes));
  return d;
}

// Format a Date for a datetime-local input value (local time, no seconds).
export function toLocalInputValue(date) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(
    date.getDate()
  )}T${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

export function fromLocalInputValue(value) {
  // value: "YYYY-MM-DDTHH:MM"
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

const WEEKDAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
export function weekdayName(index) {
  return WEEKDAY_NAMES[index];
}
