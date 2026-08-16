// Date utilities. All "week" logic uses the browser's local time zone.

export const DAY_MS = 24 * 60 * 60 * 1000;
export const MINUTES_PER_DAY = 24 * 60;

// Monday-based start of week (local).
export function startOfWeek(date) {
  const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const dow = d.getDay(); // 0 Sun .. 6 Sat
  const diff = (dow + 6) % 7; // days since Monday
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

// Minutes from local midnight of `dayStart` for a given absolute Date.
export function minutesFromMidnight(date, dayStart) {
  return (date.getTime() - dayStart.getTime()) / 60000;
}

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

export function weekdayLabel(index) {
  return WEEKDAYS[index];
}

export function formatDayHeaderDate(d) {
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

export function pad2(n) {
  return String(n).padStart(2, '0');
}

export function formatTimeHM(date) {
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

// minutes -> "HH:MM"
export function minutesToHM(min) {
  const m = Math.max(0, Math.round(min));
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return `${pad2(h % 24 === 0 && h === 24 ? 24 : h)}:${pad2(mm)}`;
}

// Build a value for <input type="datetime-local"> from a Date (local).
export function toDatetimeLocalValue(date) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(
    date.getDate()
  )}T${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

// Parse a datetime-local string into a local Date.
export function fromDatetimeLocalValue(value) {
  return new Date(value);
}

export function formatWeekRange(weekStart) {
  const end = addDays(weekStart, 6);
  const opts = { month: 'short', day: 'numeric' };
  const startStr = weekStart.toLocaleDateString(undefined, opts);
  const endStr = end.toLocaleDateString(undefined, { ...opts, year: 'numeric' });
  return `${startStr} – ${endStr}`;
}
