// Date helpers operating in the browser's local time zone.

export const DAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/** Start of the Monday of the week containing `date` (local midnight). */
export function startOfWeek(date) {
  const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  // getDay(): 0=Sun..6=Sat. We want Monday as the first column.
  const day = d.getDay();
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

export function addWeeks(date, n) {
  return addDays(date, n * 7);
}

/** Returns the 7 local-midnight Date objects Mon..Sun for the week of `date`. */
export function weekDays(date) {
  const start = startOfWeek(date);
  return Array.from({ length: 7 }, (_, i) => addDays(start, i));
}

export function isSameDay(a, b) {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

/** Local-midnight start of the day for `date`. */
export function dayStart(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), 0, 0, 0, 0);
}

/** Local midnight of the *next* day (exclusive day end = 24:00). */
export function dayEnd(date) {
  const d = dayStart(date);
  d.setDate(d.getDate() + 1);
  return d;
}

export function pad2(n) {
  return String(n).padStart(2, '0');
}

/** Format a Date as local HH:MM. */
export function formatTime(date) {
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

/** Format minutes-from-midnight (may equal 1440) as HH:MM. */
export function formatMinutes(min) {
  const m = Math.round(min);
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return `${pad2(h)}:${pad2(mm)}`;
}

/** Build a local Date from a day (date) plus minutes-from-midnight. */
export function dateFromDayAndMinutes(day, minutes) {
  const d = dayStart(day);
  d.setMinutes(d.getMinutes() + Math.round(minutes));
  return d;
}

/** Convert a Date to the value expected by <input type="datetime-local">. */
export function toDatetimeLocalValue(date) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(
    date.getDate()
  )}T${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

/** Parse a <input type="datetime-local"> value into a local Date. */
export function fromDatetimeLocalValue(value) {
  // value like "2024-05-01T09:30"
  const [datePart, timePart] = value.split('T');
  const [y, mo, d] = datePart.split('-').map(Number);
  const [h, mi] = timePart.split(':').map(Number);
  return new Date(y, mo - 1, d, h, mi, 0, 0);
}

export function formatDateRangeLabel(days) {
  const first = days[0];
  const last = days[6];
  const opts = { month: 'short', day: 'numeric' };
  const firstStr = first.toLocaleDateString(undefined, opts);
  const lastStr = last.toLocaleDateString(undefined, {
    ...opts,
    year: 'numeric',
  });
  return `${firstStr} – ${lastStr}`;
}
