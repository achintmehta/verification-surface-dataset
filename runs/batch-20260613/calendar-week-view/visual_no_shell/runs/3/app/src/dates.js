/**
 * Date utility functions for the week calendar.
 * All operations work in local time.
 */

/**
 * Returns the Monday of the week containing the given date.
 */
export function getWeekStart(date) {
  const d = new Date(date);
  const day = d.getDay(); // 0=Sun, 1=Mon, ..., 6=Sat
  const diff = (day === 0) ? -6 : 1 - day; // adjust to Monday
  d.setDate(d.getDate() + diff);
  d.setHours(0, 0, 0, 0);
  return d;
}

/**
 * Returns the Sunday (end of week) at 24:00 (= next Monday 00:00).
 */
export function getWeekEnd(weekStart) {
  const d = new Date(weekStart);
  d.setDate(d.getDate() + 7);
  d.setHours(0, 0, 0, 0);
  return d;
}

/**
 * Returns an array of 7 Date objects (Mon–Sun) for the given week start.
 */
export function getWeekDays(weekStart) {
  const days = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(weekStart);
    d.setDate(d.getDate() + i);
    days.push(d);
  }
  return days;
}

/**
 * Formats a Date as "Mon Jan 6" style.
 */
export function formatDayHeader(date) {
  return date.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}

/**
 * Formats a Date as "Jan 6 – Jan 12, 2025" for the week label.
 */
export function formatWeekLabel(weekStart, weekEnd) {
  const endDay = new Date(weekEnd);
  endDay.setDate(endDay.getDate() - 1); // last day is Sunday

  const startStr = weekStart.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  const endStr = endDay.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  return `${startStr} – ${endStr}`;
}

/**
 * Formats a Date as ISO datetime-local string (for input[type=datetime-local]).
 * e.g. "2025-01-06T09:00"
 */
export function toDatetimeLocal(date) {
  const d = new Date(date);
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * Formats a time as "9:00 AM" style.
 */
export function formatTime(date) {
  return new Date(date).toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
}

/**
 * Returns true if two dates are the same calendar day (local time).
 */
export function isSameDay(a, b) {
  const da = new Date(a);
  const db = new Date(b);
  return da.getFullYear() === db.getFullYear() &&
         da.getMonth() === db.getMonth() &&
         da.getDate() === db.getDate();
}

/**
 * Returns true if the given date is today.
 */
export function isToday(date) {
  return isSameDay(date, new Date());
}

/**
 * Given a day Date and a Y pixel offset within the day body,
 * returns a Date at that time (clamped to 00:00–24:00).
 */
export function pixelToTime(dayDate, yPixel, hourHeight) {
  const totalMinutes = Math.round((yPixel / hourHeight) * 60);
  const clamped = Math.max(0, Math.min(24 * 60, totalMinutes));
  const d = new Date(dayDate);
  d.setHours(0, clamped, 0, 0);
  return d;
}

/**
 * Returns the Y pixel offset for a given time within a day.
 */
export function timeToPixel(date, hourHeight) {
  const d = new Date(date);
  const minutes = d.getHours() * 60 + d.getMinutes();
  return (minutes / 60) * hourHeight;
}

/**
 * Snaps minutes to the nearest N-minute interval.
 */
export function snapMinutes(minutes, snap = 15) {
  return Math.round(minutes / snap) * snap;
}
