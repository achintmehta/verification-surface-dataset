/**
 * Formatting utilities for the dashboard.
 */

/**
 * Format a number with thousands separators.
 * e.g. 1284750 → "1,284,750"
 */
export function formatNumber(value) {
  const n = Number(value);
  if (isNaN(n)) return '—';
  return n.toLocaleString('en-US');
}

/**
 * Format a number as USD currency.
 * e.g. 9876.54 → "$9,876.54"
 * For large values uses compact notation on the stat card.
 */
export function formatCurrency(value) {
  const n = Number(value);
  if (isNaN(n)) return '—';
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(n);
}

/**
 * Format a date string (YYYY-MM-DD or ISO) as "Jan 1, 2024".
 */
export function formatDate(dateStr) {
  if (!dateStr) return '—';
  // Handle both "YYYY-MM-DD" and full ISO strings
  const d = new Date(String(dateStr).includes('T') ? dateStr : dateStr + 'T00:00:00');
  if (isNaN(d.getTime())) return String(dateStr);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

/**
 * Format a percentage with sign.
 * e.g. 12.34 → "+12.34%", -5.6 → "-5.60%"
 */
export function formatPercent(value) {
  const n = Number(value);
  if (isNaN(n)) return '—';
  const sign = n > 0 ? '+' : '';
  return `${sign}${n.toFixed(2)}%`;
}
