// dates.js — local-time date helpers for the week view.

const DAY_MS = 24 * 60 * 60 * 1000;

// Return the Monday (00:00 local) of the week containing `date`.
export function startOfWeek(date) {
  const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  // getDay(): 0 = Sunday ... 6 = Saturday. We want Monday as the first day.
  const day = d.getDay();
  const diff = (day === 0 ? -6 : 1 - day); // shift back to Monday
  d.setDate(d.getDate() + diff);
  d.setHours(0, 0, 0, 0);
  return d;
}

// Return an array of 7 Date objects (Mon..Sun) at 00:00 local time.
export function weekDays(weekStart) {
  const days = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(weekStart.getFullYear(), weekStart.getMonth(), weekStart.getDate() + i);
    d.setHours(0, 0, 0, 0);
    days.push(d);
  }
  return days;
}

export function addWeeks(date, n) {
  const d = new Date(date.getTime() + n * 7 * DAY_MS);
  return startOfWeek(d);
}

export function isSameDay(a, b) {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

export function endOfDay(dayStart) {
  return new Date(dayStart.getFullYear(), dayStart.getMonth(), dayStart.getDate() + 1, 0, 0, 0, 0);
}

const WEEKDAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const MONTH_NAMES = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

export function weekdayName(dayStart) {
  // dayStart Mon..Sun
  const idx = (dayStart.getDay() + 6) % 7;
  return WEEKDAY_NAMES[idx];
}

export function shortDate(dayStart) {
  return `${MONTH_NAMES[dayStart.getMonth()]} ${dayStart.getDate()}`;
}

export function formatTime(date) {
  const h = String(date.getHours()).padStart(2, '0');
  const m = String(date.getMinutes()).padStart(2, '0');
  return `${h}:${m}`;
}

export function formatHourLabel(hour) {
  return `${String(hour).padStart(2, '0')}:00`;
}

// Format a Date for an <input type="datetime-local"> value (local time).
export function toDatetimeLocalValue(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}`
  );
}

// Parse a datetime-local string into a local-time Date.
export function fromDatetimeLocalValue(value) {
  // value like "2024-05-01T09:30"
  const [datePart, timePart] = value.split('T');
  if (!datePart || !timePart) return null;
  const [y, mo, d] = datePart.split('-').map(Number);
  const [h, mi] = timePart.split(':').map(Number);
  const result = new Date(y, mo - 1, d, h, mi, 0, 0);
  return Number.isNaN(result.getTime()) ? null : result;
}

// Build a Date for `dayStart` plus minutes-from-midnight.
export function dateFromDayAndMinutes(dayStart, minutes) {
  const d = new Date(dayStart.getTime());
  d.setMinutes(d.getMinutes() + Math.round(minutes));
  return d;
}

export function weekRangeLabel(weekStart) {
  const days = weekDays(weekStart);
  const first = days[0];
  const last = days[6];
  if (first.getMonth() === last.getMonth()) {
    return `${MONTH_NAMES[first.getMonth()]} ${first.getDate()}–${last.getDate()}, ${first.getFullYear()}`;
  }
  return `${shortDate(first)} – ${shortDate(last)}, ${last.getFullYear()}`;
}
