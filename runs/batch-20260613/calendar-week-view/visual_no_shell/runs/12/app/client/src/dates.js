// Date helpers operating in the browser's local time zone.

export const MINUTES_PER_DAY = 24 * 60;

// Monday as the first day of the week.
export function startOfWeek(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  const day = d.getDay(); // 0 = Sun .. 6 = Sat
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

// Minutes from midnight of `dayStart` for a given instant, clamped to [0, 1440].
export function minutesFromDayStart(instant, dayStart) {
  const ms = instant.getTime() - dayStart.getTime();
  const minutes = ms / 60000;
  return Math.max(0, Math.min(MINUTES_PER_DAY, minutes));
}

export function pad2(n) {
  return String(n).padStart(2, '0');
}

export function formatTime(date) {
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

// Build a value usable by <input type="datetime-local"> in local time.
export function toDatetimeLocal(date) {
  return (
    `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}` +
    `T${pad2(date.getHours())}:${pad2(date.getMinutes())}`
  );
}

export function fromDatetimeLocal(value) {
  // value: "YYYY-MM-DDTHH:MM" interpreted in local time.
  return new Date(value);
}

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const MONTHS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

export function weekdayLabel(index) {
  return WEEKDAYS[index];
}

export function formatWeekRange(weekStart) {
  const end = addDays(weekStart, 6);
  const startStr = `${MONTHS[weekStart.getMonth()]} ${weekStart.getDate()}`;
  const endStr =
    weekStart.getMonth() === end.getMonth()
      ? `${end.getDate()}`
      : `${MONTHS[end.getMonth()]} ${end.getDate()}`;
  const year = end.getFullYear();
  return `${startStr} – ${endStr}, ${year}`;
}

export function formatDayHeaderDate(date) {
  return `${MONTHS[date.getMonth()]} ${date.getDate()}`;
}
