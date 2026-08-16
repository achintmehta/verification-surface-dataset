// Time helpers. All in the browser's local timezone.

export const MINUTES_PER_DAY = 24 * 60;

// Returns the Monday (local) at 00:00 for the week containing `date`.
export function startOfWeek(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  const day = d.getDay(); // 0=Sun ... 6=Sat
  const diff = (day === 0 ? -6 : 1 - day); // shift to Monday
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

// Minutes from midnight of the given day's local 00:00.
export function minutesFromMidnight(date, dayStart) {
  return (date.getTime() - dayStart.getTime()) / 60000;
}

export function pad2(n) {
  return String(n).padStart(2, '0');
}

export function fmtTime(date) {
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

// Format minutes-from-midnight as HH:MM (handles 1440 -> 24:00).
export function fmtMinutes(mins) {
  const h = Math.floor(mins / 60);
  const m = Math.round(mins % 60);
  return `${pad2(h)}:${pad2(m)}`;
}

// Build a Date at the given local day + minutes from midnight.
export function dateAt(dayStart, minutes) {
  const d = new Date(dayStart);
  d.setMinutes(d.getMinutes() + minutes);
  return d;
}

// For an <input type="datetime-local"> value.
export function toLocalInputValue(date) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}T${pad2(
    date.getHours()
  )}:${pad2(date.getMinutes())}`;
}

export function fromLocalInputValue(value) {
  // datetime-local has no timezone -> interpreted as local. new Date(value)
  // treats it as local in modern browsers when the seconds are present? Be safe.
  const [datePart, timePart] = value.split('T');
  const [y, mo, d] = datePart.split('-').map(Number);
  const [h, mi] = timePart.split(':').map(Number);
  return new Date(y, mo - 1, d, h, mi, 0, 0);
}

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
export function weekdayLabel(i) {
  return WEEKDAYS[i];
}

const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
export function monthLabel(i) {
  return MONTHS[i];
}
