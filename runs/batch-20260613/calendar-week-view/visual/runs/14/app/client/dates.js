export const DAY_MS = 24 * 60 * 60 * 1000;
export const MINUTES_PER_DAY = 24 * 60;

// Start of the week (Monday 00:00 local) containing `date`.
export function startOfWeek(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  const dow = d.getDay(); // 0=Sun..6=Sat
  const diff = (dow === 0 ? -6 : 1 - dow); // shift back to Monday
  d.setDate(d.getDate() + diff);
  return d;
}

export function addDays(date, n) {
  const d = new Date(date);
  d.setDate(d.getDate() + n);
  return d;
}

export function startOfDay(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

export function sameDate(a, b) {
  return a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate();
}

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
export function weekdayLabel(i) { return WEEKDAYS[i]; }

const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

export function formatRangeLabel(weekStart) {
  const end = addDays(weekStart, 6);
  const sameMonth = weekStart.getMonth() === end.getMonth();
  const sameYear = weekStart.getFullYear() === end.getFullYear();
  if (sameMonth && sameYear) {
    return `${MONTHS[weekStart.getMonth()]} ${weekStart.getDate()} – ${end.getDate()}, ${weekStart.getFullYear()}`;
  }
  if (sameYear) {
    return `${MONTHS[weekStart.getMonth()]} ${weekStart.getDate()} – ${MONTHS[end.getMonth()]} ${end.getDate()}, ${weekStart.getFullYear()}`;
  }
  return `${MONTHS[weekStart.getMonth()]} ${weekStart.getDate()}, ${weekStart.getFullYear()} – ${MONTHS[end.getMonth()]} ${end.getDate()}, ${end.getFullYear()}`;
}

export function pad2(n) { return String(n).padStart(2, '0'); }

// Minutes from local midnight for a given Date.
export function minutesFromMidnight(date, dayStart) {
  return (date.getTime() - dayStart.getTime()) / 60000;
}

export function formatTime(date) {
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

// Build a value usable in <input type="datetime-local"> from a Date (local).
export function toDatetimeLocal(date) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}T${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

// Parse a datetime-local string as a local Date.
export function fromDatetimeLocal(str) {
  if (!str) return null;
  const [datePart, timePart] = str.split('T');
  if (!datePart || !timePart) return null;
  const [y, mo, da] = datePart.split('-').map(Number);
  const [h, mi] = timePart.split(':').map(Number);
  const d = new Date(y, mo - 1, da, h, mi, 0, 0);
  return Number.isNaN(d.getTime()) ? null : d;
}
