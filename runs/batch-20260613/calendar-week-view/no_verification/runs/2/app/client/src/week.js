/**
 * Week navigation utilities.
 * All dates are handled in local time.
 * The week starts on Monday (ISO week).
 */

const DAY_NAMES  = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const MONTH_NAMES = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

/**
 * Return the Monday of the ISO week containing `date`.
 * @param {Date} date
 * @returns {Date}  midnight local time on Monday
 */
export function getWeekStart(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  // getDay(): 0=Sun,1=Mon,...,6=Sat
  const dow = d.getDay();
  const diff = dow === 0 ? -6 : 1 - dow; // shift to Monday
  d.setDate(d.getDate() + diff);
  return d;
}

/**
 * Return an array of 7 Date objects (Mon–Sun) for the week starting at `monday`.
 * @param {Date} monday
 * @returns {Date[]}
 */
export function getWeekDays(monday) {
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(monday);
    d.setDate(d.getDate() + i);
    return d;
  });
}

/**
 * Return the UTC ISO string for the start of the week (Monday 00:00:00 local → UTC).
 * @param {Date} monday  local midnight on Monday
 * @returns {string}  UTC ISO string
 */
export function weekStartISO(monday) {
  return monday.toISOString();
}

/**
 * Return the UTC ISO string for the end of the week (next Monday 00:00:00 local → UTC).
 * @param {Date} monday  local midnight on Monday
 * @returns {string}  UTC ISO string
 */
export function weekEndISO(monday) {
  const end = new Date(monday);
  end.setDate(end.getDate() + 7);
  return end.toISOString();
}

/**
 * Format a Date as a local ISO datetime string (YYYY-MM-DDTHH:MM:SS)
 * without timezone offset — suitable for datetime-local inputs and API calls.
 * @param {Date} d
 * @returns {string}
 */
export function localISO(d) {
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T` +
         `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/**
 * Format a Date as "HH:MM" in local time.
 * @param {Date|string} dt
 * @returns {string}
 */
export function formatTime(dt) {
  const d = dt instanceof Date ? dt : new Date(dt);
  return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
}

/**
 * Format a week label like "Jun 30 – Jul 6, 2025".
 * @param {Date[]} days  array of 7 Date objects
 * @returns {string}
 */
export function formatWeekLabel(days) {
  const first = days[0];
  const last  = days[6];
  const sameMonth = first.getMonth() === last.getMonth();
  const sameYear  = first.getFullYear() === last.getFullYear();

  const m1 = MONTH_NAMES[first.getMonth()];
  const m2 = MONTH_NAMES[last.getMonth()];
  const y  = last.getFullYear();

  if (sameMonth && sameYear) {
    return `${m1} ${first.getDate()} – ${last.getDate()}, ${y}`;
  }
  if (sameYear) {
    return `${m1} ${first.getDate()} – ${m2} ${last.getDate()}, ${y}`;
  }
  return `${m1} ${first.getDate()}, ${first.getFullYear()} – ${m2} ${last.getDate()}, ${y}`;
}

/**
 * Return the short day name for a Date.
 * @param {Date} d
 * @returns {string}
 */
export function dayName(d) {
  // getDay(): 0=Sun → index 6, 1=Mon → 0, ...
  const dow = d.getDay();
  return DAY_NAMES[dow === 0 ? 6 : dow - 1];
}

/**
 * Return true if two dates fall on the same calendar day (local time).
 * @param {Date} a
 * @param {Date} b
 * @returns {boolean}
 */
export function isSameDay(a, b) {
  return a.getFullYear() === b.getFullYear() &&
         a.getMonth()    === b.getMonth()    &&
         a.getDate()     === b.getDate();
}

/**
 * Snap a pixel offset within a day column to the nearest minute.
 * @param {number} px        pixel offset from top of column
 * @param {number} hourHeight  px per hour
 * @returns {number}  minutes since midnight (0–1440)
 */
export function pxToMinutes(px, hourHeight) {
  return Math.max(0, Math.min(1440, Math.round((px / hourHeight) * 60)));
}

/**
 * Given a day Date and minutes-since-midnight, return a local ISO string.
 * @param {Date}   day
 * @param {number} minutes
 * @returns {string}
 */
export function dayMinutesToISO(day, minutes) {
  const d = new Date(day);
  d.setHours(0, 0, 0, 0);
  d.setMinutes(minutes);
  return localISO(d);
}
