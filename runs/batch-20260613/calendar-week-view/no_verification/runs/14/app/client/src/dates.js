// Date helpers operating in the browser's local time zone.

export const DAY_MS = 24 * 60 * 60 * 1000;

// Returns the Monday (00:00 local) of the week containing `date`.
export function startOfWeek(date) {
  const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  // getDay(): 0=Sun..6=Sat. We want Monday as the first day.
  const day = d.getDay();
  const diff = (day === 0 ? -6 : 1 - day); // shift back to Monday
  d.setDate(d.getDate() + diff);
  d.setHours(0, 0, 0, 0);
  return d;
}

// Returns an array of 7 Date objects (local midnight) for the week.
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
  const d = new Date(date.getTime());
  d.setDate(d.getDate() + n * 7);
  return d;
}

export function isSameDay(a, b) {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

// Minutes from local midnight of `dayStart` to `date`, clamped to [0, 1440].
export function minutesIntoDay(date, dayStart) {
  const delta = (date.getTime() - dayStart.getTime()) / 60000;
  return delta;
}

const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

export function dayName(date) {
  // Map JS getDay (0=Sun) to our Mon-first labels.
  const idx = (date.getDay() + 6) % 7;
  return DAY_NAMES[idx];
}

export function pad2(n) {
  return String(n).padStart(2, '0');
}

// Format a Date as HH:MM local.
export function formatTime(date) {
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

// Format a Date as a value for <input type="datetime-local"> (local time).
export function toLocalInputValue(date) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}T${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

// Parse a <input type="datetime-local"> value into a local Date.
export function fromLocalInputValue(value) {
  // value like "2024-01-15T09:30"
  const [datePart, timePart] = value.split('T');
  const [y, m, d] = datePart.split('-').map(Number);
  const [hh, mm] = timePart.split(':').map(Number);
  return new Date(y, m - 1, d, hh, mm, 0, 0);
}

// Build a Date from a day (local midnight) plus minutes-into-day.
export function dateFromDayMinutes(dayStart, minutes) {
  return new Date(dayStart.getTime() + minutes * 60000);
}
