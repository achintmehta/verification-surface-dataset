// Date helpers operating in the browser's local time zone.

export const DAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

// Returns the Monday (00:00 local) of the week containing `date`.
export function startOfWeek(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  const day = d.getDay(); // 0 = Sun, 1 = Mon, ...
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

export function sameDay(a, b) {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

// Minutes from local midnight of `dayStart` to `date`, clamped to [0, 1440].
export function minutesFromDayStart(date, dayStart) {
  const diffMs = date.getTime() - dayStart.getTime();
  return diffMs / 60000;
}

export function pad2(n) {
  return String(n).padStart(2, '0');
}

export function formatTime(date) {
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

// Build a value usable by <input type="datetime-local"> from a Date (local).
export function toDatetimeLocalValue(date) {
  return (
    `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}` +
    `T${pad2(date.getHours())}:${pad2(date.getMinutes())}`
  );
}

// Parse a datetime-local string into a local Date.
export function fromDatetimeLocalValue(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function formatDateRangeLabel(weekStart) {
  const weekEnd = addDays(weekStart, 6);
  const opts = { month: 'short', day: 'numeric' };
  const left = weekStart.toLocaleDateString(undefined, opts);
  const right = weekEnd.toLocaleDateString(undefined, {
    ...opts,
    year: 'numeric',
  });
  return `${left} – ${right}`;
}
