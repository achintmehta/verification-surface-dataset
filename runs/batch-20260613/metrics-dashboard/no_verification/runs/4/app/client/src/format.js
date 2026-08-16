/**
 * Format a number with thousands separators.
 */
export function formatNumber(n) {
  if (n == null || isNaN(n)) return '—';
  return new Intl.NumberFormat('en-US').format(Math.round(n));
}

/**
 * Format a number as a compact currency string (e.g. $1,234,567).
 */
export function formatCurrency(n) {
  if (n == null || isNaN(n)) return '—';
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  }).format(Math.round(n));
}

/**
 * Format a date string (ISO date or ISO timestamp) as a short human date.
 */
export function formatDate(dateStr) {
  if (!dateStr) return '—';
  // Handle both "2024-01-15" and full ISO timestamps
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return dateStr;
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(d);
}

/**
 * Format a short date for chart axis ticks (e.g. "Jan 15").
 */
export function formatShortDate(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return dateStr;
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  }).format(d);
}

/**
 * Format a percentage with one decimal place.
 */
export function formatPercent(n) {
  if (n == null || isNaN(n)) return '—';
  return `${Math.abs(n).toFixed(1)}%`;
}

/**
 * Format a large number compactly for chart Y-axis (e.g. 1200 → "1.2k").
 */
export function formatAxisValue(n) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000)     return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}k`;
  return String(Math.round(n));
}
