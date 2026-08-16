/**
 * Formatting utilities for numbers, currency, and dates.
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
 * Format a number as USD currency (no cents for large values).
 */
export function formatCurrency(value) {
  return currencyFmt.format(value);
}

/**
 * Format a number as USD currency with cents.
 */
export function formatCurrencyFull(value) {
  return currencyFmt2.format(value);
}

/**
 * Format a large integer with thousands separators.
 */
export function formatNumber(value) {
  return numberFmt.format(value);
}

/**
 * Format a number in compact notation (1.2M, 450K, etc.)
 */
export function formatCompact(value) {
  return compactFmt.format(value);
}

/**
 * Format a date string (YYYY-MM-DD or ISO) as a short date.
 */
export function formatDate(dateStr) {
  const d = new Date(dateStr);
  return d.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
  });
}

/**
 * Format a date string as a short date + time.
 */
export function formatDateTime(dateStr) {
  const d = new Date(dateStr);
  return d.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

/**
 * Format a trend percentage with sign.
 */
export function formatTrend(pct) {
  const sign = pct >= 0 ? '+' : '';
  return `${sign}${pct.toFixed(1)}%`;
}
