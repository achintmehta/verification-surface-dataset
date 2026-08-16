/**
 * Format a number with thousands separators
 */
export function formatNumber(n) {
  const num = Number(n);
  if (isNaN(num)) return '—';
  return num.toLocaleString('en-US');
}

/**
 * Format a number as currency (USD)
 */
export function formatCurrency(n) {
  const num = Number(n);
  if (isNaN(num)) return '—';
  // For large numbers, use compact notation
  if (Math.abs(num) >= 1_000_000) {
    return '$' + (num / 1_000_000).toFixed(2) + 'M';
  }
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(num);
}

/**
 * Format a date string as a short date.
 * Handles both ISO timestamps and date-only strings, always using UTC date.
 */
export function formatDate(dateStr) {
  if (!dateStr) return '—';
  // Extract just the date portion (YYYY-MM-DD) to avoid timezone shifts
  const datePart = String(dateStr).slice(0, 10);
  const parts = datePart.split('-');
  if (parts.length === 3) {
    const year = parseInt(parts[0], 10);
    const month = parseInt(parts[1], 10) - 1;
    const day = parseInt(parts[2], 10);
    if (!isNaN(year) && !isNaN(month) && !isNaN(day)) {
      // Use UTC to avoid any timezone offset
      const d = new Date(Date.UTC(year, month, day));
      return d.toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
        timeZone: 'UTC',
      });
    }
  }
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return String(dateStr);
  return d.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

/**
 * Format a percentage with sign
 */
export function formatPercent(n) {
  const num = Number(n);
  if (isNaN(num)) return '—';
  const sign = num > 0 ? '+' : '';
  return `${sign}${num.toFixed(1)}%`;
}

/**
 * Format a short date for chart axis labels (e.g. "Jan 1").
 * Always uses UTC date to avoid timezone shifts.
 */
export function formatAxisDate(dateStr) {
  if (!dateStr) return '';
  const datePart = String(dateStr).slice(0, 10);
  const parts = datePart.split('-');
  if (parts.length === 3) {
    const year = parseInt(parts[0], 10);
    const month = parseInt(parts[1], 10) - 1;
    const day = parseInt(parts[2], 10);
    if (!isNaN(year) && !isNaN(month) && !isNaN(day)) {
      const d = new Date(Date.UTC(year, month, day));
      return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
    }
  }
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

/**
 * Format a compact number for chart axis (e.g. 1.2k, 3.4M)
 */
export function formatAxisValue(n) {
  const num = Number(n);
  if (isNaN(num)) return '';
  if (Math.abs(num) >= 1_000_000) return '$' + (num / 1_000_000).toFixed(1) + 'M';
  if (Math.abs(num) >= 1_000) return '$' + (num / 1_000).toFixed(1) + 'k';
  return '$' + num.toFixed(0);
}
