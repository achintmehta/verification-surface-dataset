// Local-time date helpers. The calendar works in the browser's local zone.

/** Midnight (local) at the start of the given date. */
export function startOfDay(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

/** Monday (local midnight) of the week containing `date`. */
export function startOfWeek(date) {
  const d = startOfDay(date);
  const day = d.getDay(); // 0 = Sunday ... 6 = Saturday
  // Days since Monday: Sunday(0) -> 6, Monday(1) -> 0, etc.
  const diff = (day + 6) % 7;
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

export function isSameDay(a, b) {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

export function dayName(index) {
  return DAY_NAMES[index];
}

const MONTH_NAMES = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

export function formatDateHeader(date) {
  return `${MONTH_NAMES[date.getMonth()]} ${date.getDate()}`;
}

export function formatWeekRange(weekStart) {
  const weekEnd = addDays(weekStart, 6);
  const startStr = `${MONTH_NAMES[weekStart.getMonth()]} ${weekStart.getDate()}`;
  const endStr =
    weekStart.getMonth() === weekEnd.getMonth()
      ? `${weekEnd.getDate()}`
      : `${MONTH_NAMES[weekEnd.getMonth()]} ${weekEnd.getDate()}`;
  const year =
    weekStart.getFullYear() === weekEnd.getFullYear()
      ? weekStart.getFullYear()
      : `${weekStart.getFullYear()}–${weekEnd.getFullYear()}`;
  return `${startStr} – ${endStr}, ${year}`;
}

/** Two-digit zero-padded number. */
function pad(n) {
  return String(n).padStart(2, '0');
}

/** Format a Date as HH:MM in local time. */
export function formatTime(date) {
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * Build a Date from a day (local midnight) plus minutes-from-midnight.
 */
export function dateFromDayMinutes(dayStart, minutes) {
  const d = new Date(dayStart);
  d.setMinutes(d.getMinutes() + minutes);
  return d;
}

/**
 * Format a Date for an <input type="datetime-local"> value (local time).
 */
export function toDatetimeLocalValue(date) {
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}`
  );
}

/** Parse an <input type="datetime-local"> value into a local Date. */
export function fromDatetimeLocalValue(value) {
  // value is "YYYY-MM-DDTHH:MM" interpreted in local time.
  const [datePart, timePart] = value.split('T');
  if (!datePart || !timePart) return new Date(NaN);
  const [y, m, d] = datePart.split('-').map(Number);
  const [hh, mm] = timePart.split(':').map(Number);
  return new Date(y, m - 1, d, hh, mm, 0, 0);
}
