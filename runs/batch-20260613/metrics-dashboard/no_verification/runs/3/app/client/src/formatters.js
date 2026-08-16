/**
 * Formatting helpers for the dashboard UI.
 */

const currencyFmt = new Intl.NumberFormat('en-US', {
  style:    'currency',
  currency: 'USD',
  maximumFractionDigits: 0,
});

const numberFmt = new Intl.NumberFormat('en-US');

const dateFmt = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day:   'numeric',
  year:  'numeric',
  timeZone: 'UTC',
});

const dateTimeFmt = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day:   'numeric',
  hour:  'numeric',
  minute: '2-digit',
});

export function formatCurrency(value) {
  return currencyFmt.format(value);
}

export function formatNumber(value) {
  return numberFmt.format(value);
}

export function formatDate(dateStr) {
  // dateStr: "YYYY-MM-DD"
  const [y, m, d] = dateStr.split('-').map(Number);
  return dateFmt.format(new Date(Date.UTC(y, m - 1, d)));
}

export function formatDateTime(isoStr) {
  return dateTimeFmt.format(new Date(isoStr));
}

export function formatTrend(pct) {
  const sign = pct >= 0 ? '+' : '';
  return `${sign}${pct}%`;
}
