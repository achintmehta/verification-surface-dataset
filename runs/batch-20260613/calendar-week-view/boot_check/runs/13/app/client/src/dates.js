// Date helpers operating in the browser's local time zone.

// Returns the Monday (00:00 local) of the week containing the given date.
export function startOfWeek(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  const day = d.getDay(); // 0 = Sunday ... 6 = Saturday
  // Monday-based: shift so Monday is the start.
  const diff = (day === 0 ? -6 : 1 - day);
  d.setDate(d.getDate() + diff);
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

// Start of day (local 00:00) for a date.
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

const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

export function dayName(dayIndex) {
  return DAY_NAMES[dayIndex];
}

// Format minutes-from-midnight as HH:MM.
export function formatMinutes(min) {
  const m = Math.round(min);
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return `${String(h).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

// Format a Date as HH:MM in local time.
export function formatTime(date) {
  return `${String(date.getHours()).padStart(2, '0')}:${String(
    date.getMinutes()
  ).padStart(2, '0')}`;
}

// Convert a Date to the value string used by <input type="datetime-local">.
export function toDatetimeLocal(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}`
  );
}

// Build a Date for a given day-start plus minutes-from-midnight.
export function dateAtMinutes(dayStart, minutes) {
  const d = new Date(dayStart);
  d.setMinutes(d.getMinutes() + Math.round(minutes));
  return d;
}
