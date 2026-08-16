/**
 * Date utility helpers.
 * All operations work in local time (no timezone conversion).
 */

/** Return the Monday of the week containing `date`. */
export function getWeekStart(date) {
  const d = new Date(date);
  const day = d.getDay(); // 0=Sun, 1=Mon, …
  const diff = (day === 0 ? -6 : 1 - day); // shift to Monday
  d.setDate(d.getDate() + diff);
  d.setHours(0, 0, 0, 0);
  return d;
}

/** Return an array of 7 Date objects for Mon–Sun of the given week. */
export function getWeekDays(weekStart) {
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(weekStart);
    d.setDate(d.getDate() + i);
    return d;
  });
}

/** Format a Date as "Mon 12" style. */
export function formatDayHeader(date) {
  const dayName = date.toLocaleDateString(undefined, { weekday: 'short' });
  const dayNum  = date.getDate();
  return { dayName, dayNum };
}

/** Format a Date as "YYYY-MM-DDTHH:MM" for datetime-local inputs. */
export function toDatetimeLocal(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}`
  );
}

/** Parse a datetime-local string to a Date in local time. */
export function fromDatetimeLocal(str) {
  // "YYYY-MM-DDTHH:MM" — Date constructor treats this as local time
  return new Date(str);
}

/** Return ISO string for the start of a day (00:00:00.000). */
export function dayStart(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}

/** Return ISO string for the end of a day (next day 00:00:00.000). */
export function dayEnd(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + 1);
  return d.toISOString();
}

/** Return minutes since midnight for a Date. */
export function minutesFromMidnight(date) {
  return date.getHours() * 60 + date.getMinutes() + date.getSeconds() / 60;
}

/** Format a Date as "HH:MM". */
export function formatTime(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** Check if two dates are the same calendar day (local time). */
export function isSameDay(a, b) {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth()    === b.getMonth()    &&
    a.getDate()     === b.getDate()
  );
}

/** Check if a date is today. */
export function isToday(date) {
  return isSameDay(date, new Date());
}

/**
 * Format a week range label, e.g. "Jun 2 – Jun 8, 2025".
 */
export function formatWeekLabel(weekStart) {
  const weekEnd = new Date(weekStart);
  weekEnd.setDate(weekEnd.getDate() + 6);

  const opts = { month: 'short', day: 'numeric' };
  const startStr = weekStart.toLocaleDateString(undefined, opts);
  const endStr   = weekEnd.toLocaleDateString(undefined, { ...opts, year: 'numeric' });
  return `${startStr} – ${endStr}`;
}
