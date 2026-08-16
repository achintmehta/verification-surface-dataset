// Date utilities working in the browser's local time zone.

export const DAY_MS = 24 * 60 * 60 * 1000;

/** Midnight (local) of the given date. */
export function startOfDay(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

/**
 * Monday (local midnight) of the week containing `date`.
 * Week runs Monday..Sunday.
 */
export function startOfWeek(date) {
  const d = startOfDay(date);
  const dow = d.getDay(); // 0=Sun..6=Sat
  const diff = (dow + 6) % 7; // days since Monday
  d.setDate(d.getDate() - diff);
  return d;
}

/** Array of the 7 day-start Dates (Mon..Sun) for the week of `weekStart`. */
export function weekDays(weekStart) {
  const days = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(weekStart);
    d.setDate(d.getDate() + i);
    days.push(d);
  }
  return days;
}

export function addDays(date, n) {
  const d = new Date(date);
  d.setDate(d.getDate() + n);
  return d;
}

export function sameDay(a, b) {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const MONTH_NAMES = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

export function dayName(date) {
  // date is a local midnight; getDay() 0=Sun
  return DAY_NAMES[(date.getDay() + 6) % 7];
}

export function formatDateHeader(date) {
  return `${date.getDate()} ${MONTH_NAMES[date.getMonth()]}`;
}

export function formatRangeLabel(weekStart) {
  const end = addDays(weekStart, 6);
  const sameMonth = weekStart.getMonth() === end.getMonth();
  const startStr = `${MONTH_NAMES[weekStart.getMonth()]} ${weekStart.getDate()}`;
  const endStr = sameMonth
    ? `${end.getDate()}`
    : `${MONTH_NAMES[end.getMonth()]} ${end.getDate()}`;
  return `${startStr} – ${endStr}, ${end.getFullYear()}`;
}

/** Pad to 2 digits. */
function pad2(n) {
  return String(n).padStart(2, '0');
}

/** Format a Date as HH:MM in local time. */
export function formatTime(date) {
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

/** Format minutes-from-midnight (0..1440) as HH:MM. */
export function formatMinutes(min) {
  const m = Math.round(min);
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return `${pad2(h)}:${pad2(mm)}`;
}

/**
 * Format a local Date as the value of a datetime-local input
 * (YYYY-MM-DDTHH:MM), in local time.
 */
export function toDatetimeLocalValue(date) {
  return (
    `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}` +
    `T${pad2(date.getHours())}:${pad2(date.getMinutes())}`
  );
}

/** Parse a datetime-local input value into a local Date. */
export function fromDatetimeLocalValue(value) {
  // value: YYYY-MM-DDTHH:MM (interpreted as local time)
  const [datePart, timePart] = value.split('T');
  const [y, mo, d] = datePart.split('-').map(Number);
  const [h, mi] = timePart.split(':').map(Number);
  return new Date(y, mo - 1, d, h, mi, 0, 0);
}
