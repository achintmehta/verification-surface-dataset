// Date helpers. All operate in the browser's local time zone.

export const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

// Return Monday 00:00 (local) of the week containing `date`.
export function startOfWeek(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  const day = d.getDay(); // 0=Sun..6=Sat
  const diff = (day === 0 ? -6 : 1 - day); // shift back to Monday
  d.setDate(d.getDate() + diff);
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

// Minutes from local midnight of the given day's date for an absolute Date.
// `dayStart` is local midnight of the column's day.
export function minutesFromDayStart(absolute, dayStart) {
  return (absolute.getTime() - dayStart.getTime()) / 60000;
}

// Convert "HH:MM" + a day Date to an absolute Date.
export function timeStringToDate(dayStart, hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  const d = new Date(dayStart);
  d.setHours(h, m, 0, 0);
  return d;
}

// Format a Date as "HH:MM" local.
export function formatTime(date) {
  const h = String(date.getHours()).padStart(2, '0');
  const m = String(date.getMinutes()).padStart(2, '0');
  return `${h}:${m}`;
}

// Minutes -> "HH:MM". Handles 1440 (24:00).
export function minutesToTimeString(min) {
  const total = Math.round(min);
  const h = Math.floor(total / 60);
  const m = total % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

// For datetime-local input value: "YYYY-MM-DDTHH:MM" local.
export function toLocalInputValue(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}`
  );
}

export function fromLocalInputValue(value) {
  // value is "YYYY-MM-DDTHH:MM" interpreted as local time
  return new Date(value);
}

export function formatRangeLabel(start, end) {
  const opts = { month: 'short', day: 'numeric' };
  const startStr = start.toLocaleDateString(undefined, opts);
  const endStr = end.toLocaleDateString(undefined, { ...opts, year: 'numeric' });
  return `${startStr} – ${endStr}`;
}
