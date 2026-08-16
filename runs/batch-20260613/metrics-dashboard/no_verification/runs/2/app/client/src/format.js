/**
 * Formatting utilities for the dashboard.
 */

/** Format a number as a locale integer with commas. */
export function fmtInt(n) {
  return Math.round(n).toLocaleString('en-US');
}

/** Format a number as USD currency. */
export function fmtCurrency(n) {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(n);
}

/** Format a date string (YYYY-MM-DD or ISO) to a readable date. */
export function fmtDate(dateStr) {
  const d = new Date(
    typeof dateStr === 'string' && dateStr.length === 10
      ? dateStr + 'T00:00:00'
      : dateStr
  );
  return d.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

/** Format a short date (no year). */
export function fmtShortDate(dateStr) {
  const d = new Date(
    typeof dateStr === 'string' && dateStr.length === 10
      ? dateStr + 'T00:00:00'
      : dateStr
  );
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

/** Format a trend percentage with sign and arrow. */
export function fmtTrend(pct) {
  const sign  = pct > 0 ? '+' : '';
  const arrow = pct > 0 ? '▲' : pct < 0 ? '▼' : '—';
  const cls   = pct > 0 ? 'trend-up' : pct < 0 ? 'trend-down' : 'trend-flat';
  return { text: `${arrow} ${sign}${pct}% vs prior 7 days`, cls };
}
