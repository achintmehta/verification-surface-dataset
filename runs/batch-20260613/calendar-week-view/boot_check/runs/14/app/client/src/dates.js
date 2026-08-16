// Date helpers operating in the browser's local time zone.

export const DAY_MS = 24 * 60 * 60 * 1000;

// Return the Monday 00:00 (local) of the week containing `date`.
export function startOfWeek(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  const day = d.getDay(); // 0=Sun .. 6=Sat
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

// Minutes from local midnight of `dayStart` for an absolute Date `t`,
// clamped to [0, 1440] for rendering within the day column.
export function minutesIntoDay(t, dayStart) {
  const ms = t.getTime() - dayStart.getTime();
  return ms / 60000;
}

export function clamp(value, lo, hi) {
  return Math.max(lo, Math.min(hi, value));
}

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

export function weekdayLabel(index) {
  return WEEKDAYS[index];
}

export function formatHour(h) {
  return `${String(h).padStart(2, '0')}:00`;
}

export function formatTimeRange(start, end) {
  return `${formatClock(start)}\u2013${formatClock(end)}`;
}

export function formatClock(d) {
  return `${String(d.getHours()).padStart(2, '0')}:${String(
    d.getMinutes()
  ).padStart(2, '0')}`;
}

// Format a Date as a value usable by <input type="datetime-local"> (local time).
export function toDatetimeLocal(d) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(
    d.getDate()
  )}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// Parse a datetime-local string into a local Date.
export function fromDatetimeLocal(s) {
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function formatWeekRange(weekStart) {
  const weekEnd = addDays(weekStart, 6);
  const opts = { month: 'short', day: 'numeric' };
  const sameMonth = weekStart.getMonth() === weekEnd.getMonth();
  const startStr = weekStart.toLocaleDateString(undefined, opts);
  const endStr = weekEnd.toLocaleDateString(
    undefined,
    sameMonth ? { day: 'numeric' } : opts
  );
  return `${startStr} \u2013 ${endStr}, ${weekEnd.getFullYear()}`;
}
