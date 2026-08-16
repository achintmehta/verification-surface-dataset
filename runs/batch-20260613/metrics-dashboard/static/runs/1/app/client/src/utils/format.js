/**
 * Formatting helpers for numbers, currency, dates.
 */

const currencyFmt = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 0,
  maximumFractionDigits: 0,
});

const currencyFmt2 = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const numberFmt = new Intl.NumberFormat('en-US');

const compactFmt = new Intl.NumberFormat('en-US', {
  notation: 'compact',
  maximumFractionDigits: 1,
});

/**
 * Format a dollar amount.
 * @param {number} value
 * @param {boolean} [compact=false]
 */
export function formatCurrency(value, compact = false) {
  if (compact) return compactFmt.format(value).replace(/^/, '$');
  return currencyFmt.format(value);
}

export function formatCurrency2(value) {
  return currencyFmt2.format(value);
}

/**
 * Format an integer with thousands separators.
 * @param {number} value
 */
export function formatNumber(value) {
  return numberFmt.format(Math.round(value));
}

/**
 * Format a percentage with sign.
 * @param {number} pct  e.g. 12.3 → "+12.3%"
 */
export function formatTrend(pct) {
  const sign = pct >= 0 ? '+' : '';
  return `${sign}${pct.toFixed(1)}%`;
}

/**
 * Format an ISO date string as "Jan 5" or "Jan 5, 2024".
 * @param {string} dateStr  "YYYY-MM-DD"
 * @param {boolean} [includeYear=false]
 */
export function formatDate(dateStr, includeYear = false) {
  // Parse as local date to avoid UTC offset shifting the day
  const [y, m, d] = dateStr.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  const opts = includeYear
    ? { month: 'short', day: 'numeric', year: 'numeric' }
    : { month: 'short', day: 'numeric' };
  return date.toLocaleDateString('en-US', opts);
}

/**
 * Format a timestamp string as a short date.
 * @param {string} ts
 */
export function formatTimestamp(ts) {
  const date = new Date(ts);
  return date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}
