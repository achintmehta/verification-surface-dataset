// Date / time utilities operating in the browser's local time zone.

export const MINUTES_PER_DAY = 24 * 60;

/** Start of the week (Monday 00:00 local) containing `date`. */
export function startOfWeek(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  const dow = d.getDay(); // 0=Sun..6=Sat
  const diff = (dow + 6) % 7; // days since Monday
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

export function startOfDay(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

export function isSameDay(a, b) {
  return a.getFullYear() === b.getFullYear() &&
         a.getMonth() === b.getMonth() &&
         a.getDate() === b.getDate();
}

/** Minutes from local midnight of the given day for `date`, clamped to [0, 1440]. */
export function minutesFromMidnight(date, dayStart) {
  const diffMs = date.getTime() - dayStart.getTime();
  return diffMs / 60000;
}

const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

export function dayName(index) {
  return DAY_NAMES[index];
}

export function formatDayHeader(date) {
  return `${date.getDate()}`;
}

export function pad2(n) {
  return String(n).padStart(2, '0');
}

/** "HH:MM" in local time. */
export function formatTime(date) {
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

/** Build a `datetime-local`-friendly string (no seconds) in local time. */
export function toLocalInputValue(date) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}T${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

/** Parse a `datetime-local` value (local time) into a Date. */
export function fromLocalInputValue(value) {
  // value like 2024-01-01T09:30
  const [datePart, timePart] = value.split('T');
  const [y, m, d] = datePart.split('-').map(Number);
  const [hh, mm] = timePart.split(':').map(Number);
  return new Date(y, m - 1, d, hh, mm, 0, 0);
}
