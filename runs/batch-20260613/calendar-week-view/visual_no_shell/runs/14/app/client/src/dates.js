// Date utilities. Weeks run Monday -> Sunday. All times are in the
// browser's local timezone.

export function startOfDay(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

// Monday as the first day of the week.
export function startOfWeek(d) {
  const x = startOfDay(d);
  const day = x.getDay(); // 0=Sun..6=Sat
  const diff = (day === 0 ? -6 : 1 - day); // shift back to Monday
  x.setDate(x.getDate() + diff);
  return x;
}

export function addDays(d, n) {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}

export function addWeeks(d, n) {
  return addDays(d, n * 7);
}

export function sameDay(a, b) {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

// Minutes from midnight of `dayStart` for a given Date, NOT clamped.
export function minutesFromDayStart(date, dayStart) {
  return (date.getTime() - dayStart.getTime()) / 60000;
}

const DOW = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function dayLabel(date) {
  return DOW[(date.getDay() + 6) % 7];
}

export function dateLabel(date) {
  return `${date.getDate()}`;
}

export function monthLabel(date) {
  return MONTHS[date.getMonth()];
}

export function weekRangeLabel(weekStart) {
  const end = addDays(weekStart, 6);
  const sameMonth = weekStart.getMonth() === end.getMonth();
  const sameYear = weekStart.getFullYear() === end.getFullYear();
  if (sameMonth) {
    return `${monthLabel(weekStart)} ${weekStart.getDate()}–${end.getDate()}, ${weekStart.getFullYear()}`;
  }
  if (sameYear) {
    return `${monthLabel(weekStart)} ${weekStart.getDate()} – ${monthLabel(end)} ${end.getDate()}, ${weekStart.getFullYear()}`;
  }
  return `${monthLabel(weekStart)} ${weekStart.getDate()}, ${weekStart.getFullYear()} – ${monthLabel(end)} ${end.getDate()}, ${end.getFullYear()}`;
}

// Format a Date to value usable in <input type="datetime-local"> (local).
export function toDatetimeLocal(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function formatTime(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

// Format a time given as minutes-from-midnight (0..1440).
export function formatMinutes(min) {
  const pad = (n) => String(n).padStart(2, '0');
  const m = Math.round(min);
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return `${pad(h)}:${pad(mm)}`;
}
