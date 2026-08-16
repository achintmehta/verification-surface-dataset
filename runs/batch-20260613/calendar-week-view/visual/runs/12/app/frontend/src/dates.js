// Date helpers operating in the browser's local timezone.

export const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

// Return the Monday (00:00 local) of the week containing `date`.
export function startOfWeek(date) {
  const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const day = d.getDay(); // 0=Sun..6=Sat
  const diff = (day === 0 ? -6 : 1 - day); // shift back to Monday
  d.setDate(d.getDate() + diff);
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

export function isSameDay(a, b) {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

// Minutes from local midnight of `dayStart` to `date`, clamped to [0, 1440].
export function minutesFromMidnight(date, dayStart) {
  const ms = date.getTime() - dayStart.getTime();
  const min = ms / 60000;
  return Math.max(0, Math.min(1440, min));
}

export function pad2(n) {
  return String(n).padStart(2, '0');
}

export function formatTime(date) {
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

export function formatRange(start, end) {
  return `${formatTime(start)}–${formatTime(end)}`;
}

// Format a Date as a value usable in <input type="datetime-local"> (local time).
export function toDatetimeLocal(date) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(
    date.getDate()
  )}T${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

// Build a Date for a given day at a given minutes-from-midnight value.
export function dateAtMinutes(dayStart, minutes) {
  const d = new Date(dayStart);
  d.setMinutes(d.getMinutes() + Math.round(minutes));
  return d;
}

export function formatMonthRange(weekStart) {
  const weekEnd = addDays(weekStart, 6);
  const opts = { month: 'short', day: 'numeric' };
  const startStr = weekStart.toLocaleDateString(undefined, opts);
  const endStr = weekEnd.toLocaleDateString(undefined, {
    ...opts,
    year: 'numeric',
  });
  return `${startStr} – ${endStr}`;
}
