// Date helpers operating in the browser's local time zone.

export const MS_PER_DAY = 24 * 60 * 60 * 1000;

// Returns the Monday at 00:00 local time for the week containing `date`.
export function startOfWeek(date) {
  const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const day = d.getDay(); // 0=Sun..6=Sat
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

export function isSameDay(a, b) {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

// Minutes from local midnight of its own day.
export function minutesFromMidnight(date) {
  return date.getHours() * 60 + date.getMinutes() + date.getSeconds() / 60;
}

const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
export function dayLabel(date) {
  return DAY_NAMES[(date.getDay() + 6) % 7];
}

export function formatTime(date) {
  const h = String(date.getHours()).padStart(2, '0');
  const m = String(date.getMinutes()).padStart(2, '0');
  return `${h}:${m}`;
}

export function formatRange(start, end) {
  return `${formatTime(start)}–${formatTime(end)}`;
}

// Build a value suitable for <input type="datetime-local"> in local time.
export function toDatetimeLocalValue(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}`
  );
}

// Parse a datetime-local value back into a Date (local time zone).
export function fromDatetimeLocalValue(value) {
  return new Date(value);
}

export function monthYearLabel(weekStart) {
  const weekEnd = addDays(weekStart, 6);
  const fmt = (d) =>
    d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  const year = weekEnd.getFullYear();
  return `${fmt(weekStart)} – ${fmt(weekEnd)}, ${year}`;
}
