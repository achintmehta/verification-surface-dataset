/**
 * Formatting utilities for the dashboard.
 */

/**
 * Format a number with thousands separators.
 * e.g. 1234567 → "1,234,567"
 */
export function formatNumber(value) {
  const n = Number(value);
  if (isNaN(n)) return '—';
  return n.toLocaleString('en-US');
}

/**
 * Format a number as USD currency.
 * e.g. 12345.67 → "$12,345.67"
 */
export function formatCurrency(value) {
  const n = Number(value);
  if (isNaN(n)) return '—';
  return n.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

/**
 * Format a percentage value (sign included).
 * e.g.  12.34 → "12.34%"
 *       -5.67 → "-5.67%"
 */
export function formatPercent(value) {
  const n = Number(value);
  if (isNaN(n)) return '—';
  return `${n.toFixed(2)}%`;
}

/**
 * Format a date string or Date object to a human-readable short date.
 * e.g. "2024-01-15" → "Jan 15, 2024"
 */
export function formatDate(value) {
  if (!value) return '—';
  // Handle both "YYYY-MM-DD" and ISO timestamp strings
  const str = String(value);
  // If it's a plain date (no time component), append T00:00:00 to avoid
  // timezone-shift issues when parsed by Date()
  const d = str.length === 10
    ? new Date(str + 'T00:00:00')
    : new Date(str);
  if (isNaN(d.getTime())) return String(value);
  return d.toLocaleDateString('en-US', {
    month: 'short',
    day:   'numeric',
    year:  'numeric',
  });
}
