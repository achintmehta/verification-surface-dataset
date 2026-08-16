// Date / time helpers. All in the browser's local time zone.

export const MINUTES_PER_DAY = 24 * 60;

/** Return the Monday (local) at 00:00 of the week containing `date`. */
export function startOfWeek(date) {
  const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  // getDay(): 0 = Sunday ... 6 = Saturday. We want Monday as the first day.
  const dow = (d.getDay() + 6) % 7; // 0 = Monday
  d.setDate(d.getDate() - dow);
  d.setHours(0, 0, 0, 0);
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

/** Start of the day (local 00:00) containing `date`. */
export function startOfDay(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

export function isSameDay(a, b) {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

/** Minutes from local midnight of `dayStart` to `date`, may be <0 or >1440. */
export function minutesFromDayStart(date, dayStart) {
  return (date.getTime() - dayStart.getTime()) / 60000;
}

const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const MONTH_NAMES = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

export function dayName(index) {
  return DAY_NAMES[index];
}

export function formatDayHeader(date) {
  return `${date.getDate()} ${MONTH_NAMES[date.getMonth()]}`;
}

export function formatWeekRange(weekStart) {
  const end = addDays(weekStart, 6);
  const startStr = `${weekStart.getDate()} ${MONTH_NAMES[weekStart.getMonth()]}`;
  const endStr = `${end.getDate()} ${MONTH_NAMES[end.getMonth()]} ${end.getFullYear()}`;
  return `${startStr} – ${endStr}`;
}

/** Format a Date as HH:MM (24h, local). */
export function formatHM(date) {
  const h = String(date.getHours()).padStart(2, '0');
  const m = String(date.getMinutes()).padStart(2, '0');
  return `${h}:${m}`;
}

/** Format minutes-from-midnight as HH:MM. */
export function formatMinutes(min) {
  const clamped = Math.max(0, Math.min(MINUTES_PER_DAY, Math.round(min)));
  const h = Math.floor(clamped / 60);
  const m = clamped % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/**
 * Build a local Date from a day-start date and a minutes-from-midnight value.
 */
export function dateFromDayMinutes(dayStart, minutes) {
  const d = new Date(dayStart);
  d.setMinutes(d.getMinutes() + Math.round(minutes));
  return d;
}

/**
 * Produce the value string for an <input type="datetime-local"> from a Date,
 * using local time.
 */
export function toDatetimeLocalValue(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}`
  );
}

/** Parse a datetime-local value (local time) into a Date. */
export function fromDatetimeLocalValue(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}
