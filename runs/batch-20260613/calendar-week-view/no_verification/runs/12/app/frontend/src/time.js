// Time / date helpers. All wall-clock reasoning is in the browser's local zone.

export const MINUTES_PER_DAY = 24 * 60;

/** Start of the day (local) for a given Date. */
export function startOfDay(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

/**
 * Monday of the week containing `date` (local), at 00:00.
 * getDay(): 0=Sunday..6=Saturday. We want Monday as the first column.
 */
export function startOfWeek(date) {
  const d = startOfDay(date);
  const day = d.getDay(); // 0..6, Sun..Sat
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

export function isSameDay(a, b) {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

/** Minutes from midnight of `dayStart` to `date` (can be <0 or >1440). */
export function minutesFrom(dayStart, date) {
  return (date.getTime() - dayStart.getTime()) / 60000;
}

/** Format a Date as HH:MM (24h, local). */
export function formatTime(date) {
  const h = String(date.getHours()).padStart(2, '0');
  const m = String(date.getMinutes()).padStart(2, '0');
  return `${h}:${m}`;
}

/** Build a value for an <input type="datetime-local"> from a local Date. */
export function toLocalInputValue(date) {
  const y = date.getFullYear();
  const mo = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  const h = String(date.getHours()).padStart(2, '0');
  const mi = String(date.getMinutes()).padStart(2, '0');
  return `${y}-${mo}-${d}T${h}:${mi}`;
}

/** Parse a datetime-local input value into a local Date. */
export function fromLocalInputValue(value) {
  // value is "YYYY-MM-DDTHH:MM"; new Date() parses this as local time.
  return new Date(value);
}

const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const MONTH_NAMES = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

export function dayName(index) {
  return DAY_NAMES[index];
}

export function formatDateShort(date) {
  return `${MONTH_NAMES[date.getMonth()]} ${date.getDate()}`;
}

export function formatRangeLabel(weekStart) {
  const weekEnd = addDays(weekStart, 6);
  const sameMonth = weekStart.getMonth() === weekEnd.getMonth();
  if (sameMonth) {
    return `${MONTH_NAMES[weekStart.getMonth()]} ${weekStart.getDate()}–${weekEnd.getDate()}, ${weekStart.getFullYear()}`;
  }
  return `${formatDateShort(weekStart)} – ${formatDateShort(weekEnd)}, ${weekEnd.getFullYear()}`;
}
