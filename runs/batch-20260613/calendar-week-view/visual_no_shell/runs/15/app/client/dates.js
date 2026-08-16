// Date helpers operating in the browser's local time zone.

export const MINUTES_PER_DAY = 1440;

// Monday as the first day of the week.
export function startOfWeek(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  const day = d.getDay(); // 0=Sun..6=Sat
  const diff = (day + 6) % 7; // days since Monday
  d.setDate(d.getDate() - diff);
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

export function isSameDay(a, b) {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

// Minutes from midnight of `dayStart` for a given absolute Date, clamped to [0, 1440].
export function minutesFromDayStart(date, dayStart) {
  const ms = date.getTime() - dayStart.getTime();
  const mins = ms / 60000;
  if (mins < 0) return 0;
  if (mins > MINUTES_PER_DAY) return MINUTES_PER_DAY;
  return mins;
}

export function formatTime(date) {
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function formatTimeRange(start, end) {
  return `${formatTime(start)} – ${formatTime(end)}`;
}

// "YYYY-MM-DD" in local time for date inputs.
export function toDateInputValue(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

// "HH:MM" in local time for time inputs.
export function toTimeInputValue(date) {
  const h = String(date.getHours()).padStart(2, '0');
  const m = String(date.getMinutes()).padStart(2, '0');
  return `${h}:${m}`;
}

// Build a local Date from "YYYY-MM-DD" and "HH:MM".
export function fromDateAndTime(dateStr, timeStr) {
  const [y, mo, d] = dateStr.split('-').map(Number);
  const [h, mi] = timeStr.split(':').map(Number);
  return new Date(y, mo - 1, d, h, mi, 0, 0);
}

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

export function weekdayLabel(index) {
  return WEEKDAYS[index];
}

export function formatWeekRange(weekStart) {
  const weekEnd = addDays(weekStart, 6);
  const opts = { month: 'short', day: 'numeric' };
  const startStr = weekStart.toLocaleDateString([], opts);
  const endStr = weekEnd.toLocaleDateString([], { ...opts, year: 'numeric' });
  return `${startStr} – ${endStr}`;
}
