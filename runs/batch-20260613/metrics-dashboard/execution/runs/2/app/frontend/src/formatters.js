/**
 * formatters.js — number and date formatting helpers.
 */

/** Format a currency value, e.g. 1284750 → "$1,284,750.00" */
export function fmtCurrency(n) {
  return '$' + Number(n).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

/** Format a large integer with commas, e.g. 1284750 → "1,284,750" */
export function fmtInt(n) {
  return Number(n).toLocaleString('en-US');
}

/** Format a percentage with sign, e.g. 3.2 → "+3.2%" */
export function fmtPct(n) {
  if (n === null || n === undefined) return '—';
  const sign = n > 0 ? '+' : '';
  return `${sign}${Number(n).toFixed(1)}%`;
}

/** Format a date string "YYYY-MM-DD" → "Jan 5, 2025" */
export function fmtDate(dateStr) {
  if (!dateStr) return '—';
  const [y, m, d] = String(dateStr).slice(0, 10).split('-').map(Number);
  const months = ['Jan','Feb','Mar','Apr','May','Jun',
                  'Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${months[m - 1]} ${d}, ${y}`;
}

/** Format an ISO timestamp → "Jan 5, 2025" */
export function fmtTimestamp(iso) {
  if (!iso) return '—';
  return fmtDate(String(iso).slice(0, 10));
}

/** Compact number for stat cards: 1284750 → "1,284,750" (full, no abbreviation) */
export function fmtStatNumber(n) {
  return Number(n).toLocaleString('en-US');
}
