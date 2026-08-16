// ─── Number Formatting ────────────────────────────────────────────────────────

export function formatNumber(n) {
  if (n == null) return '—';
  return new Intl.NumberFormat('en-US').format(n);
}

export function formatCurrency(n) {
  if (n == null) return '—';
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(n);
}

export function formatDate(isoStr) {
  if (!isoStr) return '—';
  const d = new Date(isoStr);
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  }).format(d);
}

export function formatShortDate(isoStr) {
  if (!isoStr) return '—';
  // Handle both "2024-01-15" and full ISO strings
  const d = new Date(isoStr + (isoStr.length === 10 ? 'T00:00:00' : ''));
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
  }).format(d);
}

export function formatAxisDate(isoStr) {
  if (!isoStr) return '';
  const d = new Date(isoStr + (isoStr.length === 10 ? 'T00:00:00' : ''));
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
  }).format(d);
}

export function formatAxisNumber(n) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}k`;
  return String(n);
}
