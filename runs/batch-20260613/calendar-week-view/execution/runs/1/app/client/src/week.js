/**
 * Week navigation utilities.
 * Weeks run Monday–Sunday.
 */

const DAY_MS = 86_400_000;

/** Return the Monday of the week containing `date`. */
export function getMondayOf(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  const dow = d.getDay(); // 0=Sun … 6=Sat
  const diff = (dow === 0) ? -6 : 1 - dow;
  d.setDate(d.getDate() + diff);
  return d;
}

/** Return an array of 7 Date objects (Mon–Sun) for the week starting at monday. */
export function getWeekDays(monday) {
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(monday);
    d.setDate(d.getDate() + i);
    return d;
  });
}

/** Advance monday by `n` weeks (negative = back). */
export function shiftWeek(monday, n) {
  const d = new Date(monday);
  d.setDate(d.getDate() + n * 7);
  return d;
}

/** ISO string for the start of a day (00:00:00.000). */
export function dayStart(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}

/** ISO string for the end of a day (next day 00:00:00.000, i.e. exclusive). */
export function dayEnd(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + 1);
  return d.toISOString();
}

/** Format a Date as "Mon 5" style. */
export function formatDayHeader(date) {
  const dow = date.toLocaleDateString('en-US', { weekday: 'short' });
  const num = date.getDate();
  return { dow, num };
}

/** Format a Date as "Jan 1 – Jan 7, 2024" week label. */
export function formatWeekLabel(monday) {
  const sunday = new Date(monday);
  sunday.setDate(sunday.getDate() + 6);
  const opts = { month: 'short', day: 'numeric' };
  const start = monday.toLocaleDateString('en-US', opts);
  const end   = sunday.toLocaleDateString('en-US', { ...opts, year: 'numeric' });
  return `${start} – ${end}`;
}

/** Is `date` today? */
export function isToday(date) {
  const now = new Date();
  return date.getFullYear() === now.getFullYear()
      && date.getMonth()    === now.getMonth()
      && date.getDate()     === now.getDate();
}

/**
 * Given an event's start_at ISO string and a day Date,
 * return the event's start clamped to [dayStart, dayEnd] in minutes from midnight.
 */
export function minutesFromMidnight(isoStr) {
  const d = new Date(isoStr);
  return d.getHours() * 60 + d.getMinutes() + d.getSeconds() / 60;
}

/** Format a datetime-local string (YYYY-MM-DDTHH:MM) from a Date. */
export function toDatetimeLocal(date) {
  const pad = n => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth()+1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** Format time as "HH:MM". */
export function formatTime(isoStr) {
  const d = new Date(isoStr);
  const pad = n => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
